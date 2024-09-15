import minimist from 'minimist';

export function parseArgs(opts: minimist.Opts, helpDescriptions: { [key: string]: string }): minimist.ParsedArgs {
  if (!opts) {
    opts = {};
  }
  if (!opts.boolean) {
    opts.boolean = [];
  }
  if (!opts.alias) {
    opts.alias = {};
  }
  if (typeof opts.boolean === 'string' && opts.boolean !== 'h') {
    opts.boolean = [opts.boolean, 'h'];
  } else if (Array.isArray(opts.boolean) && !opts.boolean.includes('h')) {
    opts.boolean.push('h');
  } else {
    opts.boolean = ['h'];
  }
  if (!opts.alias.h) {
    opts.alias.h = 'help';
  }

  const args = minimist(process.argv.slice(2), {
    boolean: ['d'],
    string: ['o'],
    alias: {
      d: 'delete',
      o: 'only',
    },
  });

  if (args.h) {
    console.log('Options:');
    for (const key in helpDescriptions) {
      console.log(`  -${key}, --${opts.alias[key]}`);
      console.log(`     ${helpDescriptions[key]}`);
    }
    process.exit(0);
  }
  return args;
}
