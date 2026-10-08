import { describe, it, expect } from 'bun:test';
import { lexBashCommand, type BashLexResult } from './bash-lexer';

/** The words of each pipeline segment, or the failure kind. */
function words(command: string): string[][] | string {
  const out: BashLexResult = lexBashCommand(command);
  if (!out.ok) return out.kind;
  return out.segments.map((seg) => seg.map((w) => w.text));
}

describe('lexBashCommand accepts', () => {
  it.each<[string, string[][]]>([
    ['git status', [['git', 'status']]],
    ['  git   log  ', [['git', 'log']]],
    ["psql -c 'SELECT id FROM \"Job\"'", [['psql', '-c', 'SELECT id FROM "Job"']]],
    ["curl -s -w '%{http_code}' http://localhost:3000/x", [['curl', '-s', '-w', '%{http_code}', 'http://localhost:3000/x']]],
    ["curl -s 'http://localhost:3000/api/jobs?status=open&limit=5'", [['curl', '-s', 'http://localhost:3000/api/jobs?status=open&limit=5']]],
    [`curl -s -X POST -d '{"a":1}' http://localhost:3000/x`, [['curl', '-s', '-X', 'POST', '-d', '{"a":1}', 'http://localhost:3000/x']]],
    ['curl -s http://localhost:3000/x | head -50', [['curl', '-s', 'http://localhost:3000/x'], ['head', '-50']]],
    ["curl -s URL | jq '.items[0]'", [['curl', '-s', 'URL'], ['jq', '.items[0]']]],
    ["curl -H'Accept: x' u", [['curl', '-HAccept: x', 'u']]],
    [`echo "a"'b'c`, [['echo', 'abc']]],
    [`echo "a b; c > d * ? ~ # { } ( ) & |"`, [['echo', 'a b; c > d * ? ~ # { } ( ) & |']]],
    [`echo '$HOME \`id\` \\ ! "'`, [['echo', '$HOME `id` \\ ! "']]],
    ["echo ''", [['echo', '']]],
    ['date +%Y-%m-%d', [['date', '+%Y-%m-%d']]],
    ['git log --format=%H a=b', [['git', 'log', '--format=%H', 'a=b']]],
    ['a|b|c', [['a'], ['b'], ['c']]],
    ["echo 'héllo'", [['echo', 'héllo']]],
  ])('%j', (command, want) => {
    expect(words(command)).toEqual(want);
  });

  it('marks a word with any quoted part as quoted, and a plain word as not', () => {
    const out = lexBashCommand(`git 'a' b"c" d`);
    if (!out.ok) throw new Error('expected ok');
    expect(out.segments[0]!.map((w) => w.quoted)).toEqual([false, true, true, false]);
  });
});

describe('lexBashCommand refuses', () => {
  it.each([
    'curl x; rm -rf y',
    'curl x && rm y',
    'a || b',
    'a | | b',
    'a |',
    '| a',
    'a |& b',
    'curl x &',
    'curl x > f',
    'curl x >> f',
    'curl x 2> f',
    'curl x &> f',
    'cat < f',
    'cat <<EOF',
    'diff <(a) <(b)',
    'tee >(a)',
    '(curl x)',
    'echo $(id)',
    'echo $HOME',
    'echo ${HOME}',
    'echo "$HOME"',
    'echo "$(id)"',
    'echo `id`',
    'echo "`id`"',
    'echo a\\ b',
    'echo "a\\"b"',
    'echo "hi!"',
    'cat *',
    'cat a?',
    'cat [ab]',
    'ls ~',
    'ls a~b',
    'echo {a,b}',
    'curl x # c',
    'echo !x',
    'echo ^a',
    'echo =ls',
    "echo 'unterminated",
    'echo "unterminated',
    'curl x\nrm y',
    'curl\tx',
    'curl x\r',
    "echo 'a\nb'",
    "echo 'a\tb'",
    'echo "a\nb"',
    'echo a b',
    'echo \u0000',
    "echo '\u0085'",
  ])('%j', (command) => {
    expect(words(command)).toBe('syntax');
  });

  it.each(['', '   '])('%j as empty', (command) => {
    expect(words(command)).toBe('empty');
  });

  it('gives a reason that names the construct and carries no command text', () => {
    const out = lexBashCommand('curl SECRETTOKEN; rm x');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain(';');
    expect(out.reason).not.toContain('SECRETTOKEN');
  });
});
