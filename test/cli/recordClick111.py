# Regenerate from repository root: uv run --no-project --isolated --with "kagura-memory[secret]==0.44.0" --with click==8.3.3 python test/cli/recordClick111.py

import json
from pathlib import Path
from click.formatting import HelpFormatter,wrap_text
cases=[]
tables=[
 [('-y, --yes','Skip confirmation prompt.'),('--help','Show this message and exit.')],
 [('--max-chars INTEGER RANGE','Response budget in characters (memory-cloud v0.115.0+).  [default: 20000; 10000<=x<=100000]'),('--actions-limit INTEGER RANGE','Limit the action page to the requested number of items.  [1<=x<=200]'),('--help','Show this message and exit.')],
 [('--an-option-with-a-very-long-name INTEGER RANGE','A deliberately long option name, whose description starts on the next line.'),('--short','')],
 [('cmd','Words with memory-cloud, non-interactive, --actions-cursor, before--after, and foo-bar-baz to test hyphenation. '*3)],
 [('unicode','日本語の説明と数字 １２３ and mathematical digits 𝟙𝟚𝟛. '*8)],
]
for rows in tables:
 f=HelpFormatter(width=80);f.indent();f.write_dl(rows)
 cases.append(dict(kind='table',rows=rows,expected=f.getvalue().rstrip('\n')))
for prog,args in [('kagura-memory sleep rollback','[OPTIONS] CONTEXT_ID REPORT_ID'),('kagura-memory resource unusually-long-command','[OPTIONS] FIRST_ARGUMENT SECOND_ARGUMENT THIRD_ARGUMENT'),('kagura-memory '+ 'long-name-'*6,'[OPTIONS] ARGUMENT'),('kagura-memory','')]:
 f=HelpFormatter(width=80);f.write_usage(prog,args)
 cases.append(dict(kind='usage',path=prog,args=args,expected=f.getvalue().rstrip('\n')))
for text in ['Simple words. '*20,'a'*100,'memory-cloud ' *14,'foo-bar-baz non-2xx A--B --long-option ' *6,'一二三四五六七八九十'*12]:
 cases.append(dict(kind='wrap',text=text,width=35,expected=wrap_text(text,35)))
Path('test/cli/helpLayout111.json').write_text(json.dumps(cases,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')


import json
from pathlib import Path
import click
from kagura_memory.cli import main
records=[]
def walk(command, path, parent=None):
    ctx=click.Context(command,info_name=path[-1] if path else 'kagura-memory',parent=parent,terminal_width=80)
    options=[]
    for param in command.get_params(ctx):
        if not isinstance(param,click.Option) or param.hidden: continue
        options.append(dict(name=param.name,forms=param.opts,secondary=param.secondary_opts,
            help=param.get_help_record(ctx),required=param.required,
            range=dict(min=param.type.min,max=param.type.max,integer=isinstance(param.type,click.IntRange))
            if isinstance(param.type,(click.IntRange,click.FloatRange)) else None))
    original = command.help
    raw = command.get_help(ctx)+'\n'
    if original:
        command.help = original.replace('kagura ', 'kagura-memory ')
    adapted = command.get_help(ctx)+'\n'
    command.help = original
    records.append(dict(path=' '.join(path),stdout=raw,binStdout=adapted,options=options))
    if isinstance(command,click.Group):
        for name in command.list_commands(ctx):walk(command.get_command(ctx,name),path+[name],ctx)
walk(main,[])
Path('test/cli/pythonHelp044.json').write_text(json.dumps(records,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(len(records),'help pages recorded')


import json
from pathlib import Path
from click.testing import CliRunner
from kagura_memory.cli import main
cases=[['--bogus'],['auth','--bogus'],['resource','tokens','--bogus'],['bogus'],['resource','bogus'],
 ['recall','q','--bogus'],['recall','q','-k'],['recall','q','--help','--bogus'],
 ['sleep','rollback'],['sleep','rollback','ctx'],['sleep','rollback','ctx','r','--yes=1'],
 ['sleep','report','ctx','r','--actions-limit','201'],['sleep','report','ctx','r','--actions-limit','abc'],
 ['bootstrap','--max-chars','1'],['changes'],['changes','--limit','0'],['list','--filters','[]'],
 ['resource','import','-r','res','-k','key','--file','__kagura_missing_111__.json'],
 ['resource','ingest-batch','-r','res','-k','key','--file','__kagura_missing_111__.json'],
 ['secret','exec','--help','--bogus']]
rows=[]
for argv in cases:
 r=CliRunner().invoke(main,argv,prog_name='kagura-memory')
 rows.append(dict(argv=argv,code=r.exit_code,stdout=r.stdout,stderr=r.stderr))
Path('test/cli/pythonUsage044.json').write_text(json.dumps(rows,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')

