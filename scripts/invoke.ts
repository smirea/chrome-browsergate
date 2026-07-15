import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { invokeBridge } from './bridge-client';
import type {
  AutomationSummary,
  BrowserTab,
  BrowserWindow,
  SessionResult,
  TabsListResult,
} from '../src/protocol';

type Group = 'window' | 'domain' | 'none';
type Sort = 'position' | 'title' | 'url' | 'domain';
type NumberedTab = BrowserTab & { number: number };

try {
  await yargs(hideBin(process.argv))
    .scriptName('invoke')
    .command('tabs', 'Inspect browser tabs', tabs => addTabsCommands(tabs).demandCommand())
    .command(
      'get-session <target>',
      'Open a tab and extract its session credential',
      command => command
        .positional('target', { type: 'string', demandOption: true, describe: 'Tab number or URL' })
        .option('json', { type: 'boolean', default: false, describe: 'Print metadata as JSON' }),
      async args => {
        const result = await invokeBridge<SessionResult>('session.get', { target: args.target });
        console.log(args.json ? JSON.stringify(result, null, 2) : result.token);
      },
    )
    .command('automations', 'Inspect or run compiled automations', commands => addAutomationCommands(commands).demandCommand())
    .demandCommand()
    .strict()
    .help()
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function addTabsCommands(argv: Argv): Argv {
  return argv.command(
    'list',
    'List tabs',
    command => command
      .option('group', {
        alias: 'g',
        choices: ['window', 'domain', 'none'] as const,
        default: 'window' as const,
      })
      .option('sort', {
        alias: 's',
        choices: ['position', 'title', 'url', 'domain'] as const,
        default: 'position' as const,
      })
      .option('json', { type: 'boolean', default: false }),
    async args => {
      const result = await invokeBridge<TabsListResult>('tabs.list');
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printTabs(result, args.group as Group, args.sort as Sort);
    },
  );
}

function addAutomationCommands(argv: Argv): Argv {
  return argv
    .command('list', 'List compiled automations', {}, async () => {
      const result = await invokeBridge<AutomationSummary[]>('automations.list');
      if (result.length === 0) {
        console.log('No automations are registered in src/automations.ts.');
        return;
      }
      for (const automation of result) {
        console.log(`${automation.id}\t${automation.matches.join(', ')}\t${automation.world}`);
      }
    })
    .command(
      'run <id> [target]',
      'Run an automation in the active or selected tab',
      command => command
        .positional('id', { type: 'string', demandOption: true })
        .positional('target', { type: 'string', describe: 'Tab number or URL' }),
      async args => {
        const result = await invokeBridge<{ id: string; tab: BrowserTab }>('automations.run', {
          id: args.id,
          target: args.target,
        });
        console.log(`Ran ${result.id} in ${result.tab.title}`);
      },
    );
}

function printTabs(result: TabsListResult, group: Group, sort: Sort): void {
  const windows = new Map(result.windows.map(window => [window.id, window]));
  const tabs = result.tabs.map<NumberedTab>((tab, index) => ({ ...tab, number: index + 1 }));
  if (tabs.length === 0) {
    console.log('No tabs open.');
    return;
  }

  if (group === 'none') {
    for (const tab of sortTabs(tabs, sort)) printTab(tab);
    return;
  }

  if (group === 'domain') {
    const groups = groupBy(tabs, tab => domainFor(tab.url));
    for (const domain of [...groups.keys()].sort()) {
      console.log(`${domain}`);
      for (const tab of sortTabs(groups.get(domain) ?? [], sort)) printTab(tab, '  ');
    }
    return;
  }

  const groups = groupBy(tabs, tab => tab.windowId);
  for (const [windowId, windowTabs] of groups) {
    const window = windows.get(windowId);
    console.log(windowLabel(window, windowId));
    for (const tab of sortTabs(windowTabs, sort)) printTab(tab, '  ');
  }
}

function sortTabs(tabs: NumberedTab[], sort: Sort): NumberedTab[] {
  return [...tabs].sort((left, right) => {
    if (sort === 'title') return left.title.localeCompare(right.title);
    if (sort === 'url') return left.url.localeCompare(right.url);
    if (sort === 'domain') return domainFor(left.url).localeCompare(domainFor(right.url)) || left.number - right.number;
    return left.number - right.number;
  });
}

function printTab(tab: NumberedTab, indent = ''): void {
  console.log(`${indent}${String(tab.number).padStart(3)}. ${tab.active ? '● ' : ''}${tab.title}`);
  console.log(`${indent}     ${tab.url || '(no URL)'}`);
}

function windowLabel(window: BrowserWindow | undefined, id: number): string {
  if (!window) return `Window ${id}`;
  const details = [window.focused ? 'focused' : '', window.incognito ? 'incognito' : '', window.type !== 'normal' ? window.type : '']
    .filter(Boolean)
    .join(', ');
  return `Window ${window.order + 1}${details ? ` (${details})` : ''}`;
}

function domainFor(value: string): string {
  try {
    return new URL(value).hostname || new URL(value).protocol.replace(':', '');
  } catch {
    return '(no domain)';
  }
}

function groupBy<T, K>(values: T[], keyFor: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
