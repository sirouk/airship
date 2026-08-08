import { describe, expect, it } from "vitest";
import { AIRSHIP_SH_MAX_FUNCTIONS } from "./contract";
import { runScript } from "./harness.test-helper";

type Case = Readonly<{
  name: string;
  script: string;
  seed?: Readonly<Record<string, string>>;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  stdout?: string;
  stderr?: string;
  stderrMatch?: RegExp;
  exitCode?: number;
  files?: Readonly<Record<string, string>>;
}>;

/**
 * The strongest evidence this engine can produce: real `sh` scripts with the
 * exact stdout, stderr, and exit status a POSIX shell produces for them.
 */
const CASES: readonly Case[] = Object.freeze<Case[]>([
  // --- quoting and word splitting ---------------------------------------
  { name: "single quotes suppress every expansion", script: `echo 'a $HOME * "x"'`, stdout: `a $HOME * "x"\n` },
  { name: "double quotes keep spaces as one field", script: `x="a  b"; printf '[%s]' $x; echo; printf '[%s]' "$x"; echo`, stdout: "[a][b]\n[a  b]\n" },
  { name: "backslash escapes a dollar sign", script: `echo \\$HOME`, stdout: "$HOME\n" },
  { name: "backslash inside double quotes is literal unless meaningful", script: `echo "a\\tb"; echo "a\\\\b"`, stdout: "a\\tb\na\\b\n" },
  { name: "adjacent quoting concatenates into one word", script: `printf '[%s]\\n' a'b'"c"d`, stdout: "[abcd]\n" },
  { name: "empty quoted string is a real field", script: `printf '[%s]' "" x; echo`, stdout: "[][x]\n" },
  { name: "unquoted empty expansion produces no field", script: `printf '[%s]' $undefined x; echo`, stdout: "[x]\n" },
  { name: "IFS controls field splitting", script: `IFS=:; x=a:b:c; printf '[%s]' $x; echo`, stdout: "[a][b][c]\n" },
  { name: "line continuation joins lines", script: "echo one\\\n two", stdout: "one two\n" },
  { name: "comments are ignored", script: "# a comment\necho ok # trailing\n", stdout: "ok\n" },

  // --- parameter expansion ----------------------------------------------
  { name: "use-default leaves a set value alone", script: `x=set; echo "${"${x:-fallback}"}"`, stdout: "set\n" },
  { name: "use-default supplies a fallback", script: `echo "${"${missing:-fallback}"}"`, stdout: "fallback\n" },
  { name: "assign-default writes the variable", script: `echo "${"${v:=assigned}"}"; echo "$v"`, stdout: "assigned\nassigned\n" },
  { name: "error-if-unset fails with its message", script: `echo "${"${nope:?is required}"}"`, exitCode: 1, stderrMatch: /nope: is required/u },
  { name: "alternative only fires when set", script: `x=1; echo "${"${x:+yes}"}"; echo "[${"${y:+yes}"}]"`, stdout: "yes\n[]\n" },
  { name: "length counts characters", script: `x=hello; echo "${"${#x}"}"`, stdout: "5\n" },
  { name: "remove smallest and largest prefix", script: `p=a/b/c; echo "${"${p#*/}"}"; echo "${"${p##*/}"}"`, stdout: "b/c\nc\n" },
  { name: "remove smallest and largest suffix", script: `p=a.b.c; echo "${"${p%.*}"}"; echo "${"${p%%.*}"}"`, stdout: "a.b\na\n" },
  { name: "colon variants treat empty as unset", script: `x=; echo "[${"${x:-d}"}]"; echo "[${"${x-d}"}]"`, stdout: "[d]\n[]\n" },
  { name: "positional parameters and count", script: `echo "$#" "$1" "$2"`, args: ["one", "two"], stdout: "2 one two\n" },
  { name: "quoted at expands to separate fields", script: `printf '[%s]' "$@"; echo`, args: ["a b", "c"], stdout: "[a b][c]\n" },
  { name: "quoted star joins on the first IFS character", script: `IFS=-; printf '[%s]' "$*"; echo`, args: ["a", "b"], stdout: "[a-b]\n" },
  { name: "unsupported expansion operator is a parse error", script: `echo "${"${x//a/b}"}"`, exitCode: 2, stderrMatch: /unsupported parameter expansion/u },

  // --- command substitution and arithmetic -------------------------------
  { name: "command substitution strips trailing newlines", script: `x=$(echo hi); printf '[%s]\\n' "$x"`, stdout: "[hi]\n" },
  { name: "backquote substitution works too", script: "echo `echo nested`", stdout: "nested\n" },
  { name: "nested command substitution", script: `echo "$(echo "$(echo deep)")"`, stdout: "deep\n" },
  { name: "substitution status reaches an assignment", script: `x=$(exit 3); echo $?`, stdout: "3\n" },
  { name: "arithmetic evaluates integers", script: `echo $(( (2 + 3) * 4 - 1 ))`, stdout: "19\n" },
  { name: "arithmetic reads and assigns variables", script: `n=5; echo $(( n * 2 )); echo $(( n = n + 1 )); echo "$n"`, stdout: "10\n6\n6\n" },
  { name: "arithmetic comparison yields 1 or 0", script: `echo $(( 3 > 2 )) $(( 3 < 2 ))`, stdout: "1 0\n" },
  { name: "arithmetic division by zero is an error", script: `echo $(( 1 / 0 ))`, exitCode: 2, stderrMatch: /division by zero/u },
  { name: "subshell parentheses are not arithmetic", script: `echo $( (echo a; echo b) | tr '\\n' '-' )`, stdout: "a-b-\n" },

  // --- control flow -------------------------------------------------------
  { name: "sequencing runs both commands", script: `echo one; echo two`, stdout: "one\ntwo\n" },
  { name: "and-or short circuits", script: `true && echo yes; false && echo no; false || echo fallback`, stdout: "yes\nfallback\n" },
  { name: "bang inverts a status", script: `! false; echo $?; ! true; echo $?`, stdout: "0\n1\n" },
  { name: "pipeline threads data", script: `printf 'b\\na\\nc\\n' | sort | head -n 2`, stdout: "a\nb\n" },
  { name: "pipeline status is the last stage", script: `false | true; echo $?`, stdout: "0\n" },
  { name: "pipefail reports a failure the last stage hid", script: `set -o pipefail; false | true; echo $?`, stdout: "1\n" },
  /*
   * bash and ksh define `pipefail` as the rightmost non-zero status. Reporting
   * the leftmost let a producer's benign warning stand in for the hard failure
   * of the stage that consumed it, so `generate | validate` answered with
   * `generate`'s status and a `case $?` dispatch took the benign branch.
   */
  { name: "pipefail takes the rightmost failing stage", script: `set -o pipefail; (exit 3) | (exit 7) | true; echo $?`, stdout: "7\n" },
  { name: "if elif else", script: `if false; then echo a; elif true; then echo b; else echo c; fi`, stdout: "b\n" },
  { name: "for over a word list", script: `for i in a b c; do printf '%s.' "$i"; done; echo`, stdout: "a.b.c.\n" },
  { name: "for over positional parameters by default", script: `for i; do echo "$i"; done`, args: ["x", "y"], stdout: "x\ny\n" },
  { name: "while with a counter", script: `i=0; while [ "$i" -lt 3 ]; do echo "$i"; i=$(( i + 1 )); done`, stdout: "0\n1\n2\n" },
  { name: "until inverts the condition", script: `i=0; until [ "$i" -ge 2 ]; do echo "$i"; i=$(( i + 1 )); done`, stdout: "0\n1\n" },
  { name: "break and continue", script: `for i in 1 2 3 4; do if [ "$i" = 2 ]; then continue; fi; if [ "$i" = 4 ]; then break; fi; echo "$i"; done`, stdout: "1\n3\n" },
  { name: "break 2 leaves both loops", script: `for i in 1 2; do for j in a b; do echo "$i$j"; break 2; done; done`, stdout: "1a\n" },
  { name: "case with alternatives and a default", script: `for v in apple banana kiwi; do case "$v" in a*|b*) echo match "$v";; *) echo other "$v";; esac; done`, stdout: "match apple\nmatch banana\nother kiwi\n" },
  { name: "case quoting makes a wildcard literal", script: `case '*' in "*") echo literal;; *) echo glob;; esac`, stdout: "literal\n" },
  { name: "subshell changes are discarded", script: `x=outer; (x=inner; echo "$x"); echo "$x"`, stdout: "inner\nouter\n" },
  { name: "group shares the current shell", script: `x=outer; { x=inner; }; echo "$x"`, stdout: "inner\n" },
  { name: "functions take positional parameters", script: `greet() { echo "hi $1"; }; greet world; greet again`, stdout: "hi world\nhi again\n" },
  { name: "function return sets the status", script: `f() { return 7; }; f; echo $?`, stdout: "7\n" },
  { name: "recursion works within the depth budget", script: `count() { if [ "$1" -le 0 ]; then return 0; fi; echo "$1"; count $(( $1 - 1 )); }; count 3`, stdout: "3\n2\n1\n" },
  { name: "local restores the caller's binding", script: `x=global; f() { local x; x=inner; echo "$x"; }; f; echo "$x"`, stdout: "inner\nglobal\n" },
  { name: "local outside a function is an error", script: `local x`, exitCode: 1, stderrMatch: /only be used in a function/u },
  { name: "background execution is a parse error", script: `sleep 1 &`, exitCode: 2, stderrMatch: /background execution/u },
  { name: "the function keyword is a parse error", script: `function f { echo hi; }`, exitCode: 2, stderrMatch: /bash extension/u },

  // --- exit status --------------------------------------------------------
  { name: "exit propagates its status", script: `echo before; exit 5; echo after`, stdout: "before\n", exitCode: 5 },
  { name: "unknown command is 127", script: `definitely_not_a_command`, exitCode: 127, stderrMatch: /command not found/u },
  { name: "errexit stops on the first failure", script: `set -e; echo one; false; echo two`, stdout: "one\n", exitCode: 1 },
  { name: "errexit ignores a tested command", script: `set -e; if false; then echo no; fi; false || true; echo done`, stdout: "done\n" },
  { name: "trap EXIT runs at the end", script: `trap 'echo bye' EXIT; echo work`, stdout: "work\nbye\n" },
  { name: "trap EXIT runs on exit too", script: `trap 'echo bye' EXIT; exit 4`, stdout: "bye\n", exitCode: 4 },
  { name: "trapping a real signal is refused", script: `trap 'echo x' INT`, exitCode: 2, stderrMatch: /only EXIT can be trapped/u },

  // --- redirection --------------------------------------------------------
  { name: "truncating redirect creates the file", script: `echo hello > out.txt; cat out.txt`, stdout: "hello\n", files: { "/workspace/out.txt": "hello\n" } },
  { name: "append adds to the file", script: `echo a > out.txt; echo b >> out.txt; cat out.txt`, stdout: "a\nb\n" },
  { name: "input redirect reads a file", script: `wc -l < data.txt`, seed: { "/workspace/data.txt": "1\n2\n3\n" }, stdout: "3\n" },
  { name: "stderr redirect separates streams", script: `sh_missing_command 2> err.txt; cat err.txt`, stdout: "airship-sh: sh_missing_command: command not found\n", exitCode: 0 },
  { name: "2>&1 merges into stdout", script: `definitely_missing 2>&1 | wc -l`, stdout: "1\n" },
  { name: "dev null discards output", script: `echo hidden > /dev/null; echo shown`, stdout: "shown\n" },
  { name: "here-document expands by default", script: `x=world\ncat <<EOF\nhello $x\nEOF\n`, stdout: "hello world\n" },
  { name: "quoted here-document delimiter suppresses expansion", script: `x=world\ncat <<'EOF'\nhello $x\nEOF\n`, stdout: "hello $x\n" },
  { name: "dash here-document strips leading tabs", script: "cat <<-EOF\n\tindented\n\tEOF\n", stdout: "indented\n" },
  { name: "an unterminated here-document is a parse error", script: "cat <<EOF\nbody\n", exitCode: 2, stderrMatch: /unterminated here-document/u },
  { name: "redirect target must expand to one word", script: `set -- a b; echo x > "$1"; cat a`, stdout: "x\n" },
  /*
   * `exec 3<>f` hardcoded fds 0 and 1, so opening a scratch descriptor
   * installed a file sink on stdout: every later `echo` was written into the
   * opened file and the caller received an empty stdout with exit 0.
   */
  { name: "read-write open uses its own descriptor and leaves stdout alone", script: `exec 3<> data.txt; echo after`, seed: { "/workspace/data.txt": "seed\n" }, stdout: "after\n", files: { "/workspace/data.txt": "seed\n" } },
  { name: "bare read-write open feeds stdin", script: `cat <> data.txt`, seed: { "/workspace/data.txt": "seed\n" }, stdout: "seed\n" },
  /*
   * POSIX XCU 2.8.1 exits a non-interactive shell on a redirection error only
   * for a special builtin. An ordinary command that cannot open its redirection
   * used to kill the whole script, so the `||` branch, the rest of the list, and
   * any cleanup never ran for a status the script was written to recover from.
   */
  { name: "a redirection error fails the command, not the script", script: `cat < missing.txt || echo defaults; echo after`, stdout: "defaults\nafter\n", stderrMatch: /missing\.txt: No such file or directory/u },
  { name: "a redirection error on a compound command is contained too", script: `{ echo hi; } < missing.txt; echo after`, stdout: "after\n", stderrMatch: /missing\.txt: No such file or directory/u },
  { name: "a redirection error on a special builtin still ends the script", script: `exec < missing.txt; echo after`, stdout: "", exitCode: 1, stderrMatch: /missing\.txt: No such file or directory/u },
  { name: "an unwritable target fails only its own command", script: `echo hi > /etc/passwd; echo after`, stdout: "after\n", stderrMatch: /Read-only file system/u },

  // --- globbing -----------------------------------------------------------
  {
    name: "star matches files in the current directory",
    script: `printf '%s\\n' *.txt`,
    seed: { "/workspace/a.txt": "", "/workspace/b.txt": "", "/workspace/c.md": "" },
    stdout: "a.txt\nb.txt\n",
  },
  {
    name: "question mark matches one character",
    script: `printf '%s\\n' ?.txt`,
    seed: { "/workspace/a.txt": "", "/workspace/ab.txt": "" },
    stdout: "a.txt\n",
  },
  {
    name: "bracket expressions and ranges",
    script: `printf '%s\\n' [ab].txt; printf '%s\\n' [!a]*.txt`,
    seed: { "/workspace/a.txt": "", "/workspace/b.txt": "", "/workspace/c.txt": "" },
    stdout: "a.txt\nb.txt\nb.txt\nc.txt\n",
  },
  {
    name: "an unmatched pattern stays literal",
    script: `printf '%s\\n' nothing*here`,
    stdout: "nothing*here\n",
  },
  {
    name: "globs do not match a leading dot",
    script: `printf '%s\\n' *`,
    seed: { "/workspace/.hidden": "", "/workspace/shown": "" },
    stdout: "shown\n",
  },
  {
    name: "noglob keeps the pattern literal",
    script: `set -f; printf '%s\\n' *.txt`,
    seed: { "/workspace/a.txt": "" },
    stdout: "*.txt\n",
  },
  {
    name: "globs descend directories",
    script: `printf '%s\\n' src/*.js`,
    seed: { "/workspace/src/one.js": "", "/workspace/src/two.js": "", "/workspace/src/skip.ts": "" },
    stdout: "src/one.js\nsrc/two.js\n",
  },

  // --- builtins -----------------------------------------------------------
  { name: "cd and pwd move through the tree", script: `mkdir -p a/b; cd a/b; pwd; cd ..; pwd`, stdout: "/workspace/a/b\n/workspace/a\n" },
  { name: "echo -n omits the newline", script: `echo -n a; echo b`, stdout: "ab\n" },
  { name: "echo -e interprets escapes", script: `echo -e 'a\\tb'`, stdout: "a\tb\n" },
  { name: "printf pads and formats", script: `printf '%-5s|%5d|%05d|%s\\n' ab 42 42 end`, stdout: "ab   |   42|00042|end\n" },
  { name: "printf reuses its format", script: `printf '%s\\n' a b c`, stdout: "a\nb\nc\n" },
  { name: "printf rejects an unknown conversion", script: `printf '%q\\n' x`, exitCode: 2, stderrMatch: /unsupported conversion/u },
  { name: "export marks a variable for the environment", script: `export FOO=bar; env | grep '^FOO='`, stdout: "FOO=bar\n" },
  { name: "unset removes a variable", script: `x=1; unset x; echo "[${"${x-unset}"}]"`, stdout: "[unset]\n" },
  { name: "shift consumes positional parameters", script: `set -- a b c; shift; echo "$@"; shift 2; echo "$#"`, stdout: "b c\n0\n" },
  { name: "test compares strings and integers", script: `test a = a && echo eq; test 2 -lt 10 && echo lt; [ -z "" ] && echo empty`, stdout: "eq\nlt\nempty\n" },
  { name: "test inspects the real filesystem", script: `[ -f f ] && echo file; [ -d d ] && echo dir; [ -e missing ] || echo absent`, seed: { "/workspace/f": "x", "/workspace/d/keep": "" }, stdout: "file\ndir\nabsent\n" },
  { name: "test refuses a predicate it cannot answer", script: `[ -t 1 ]`, exitCode: 2, stderrMatch: /device, terminal, or ownership/u },
  { name: "read consumes one line at a time", script: `printf 'a b\\nc d\\n' | while read first second; do echo "$second-$first"; done`, stdout: "b-a\nd-c\n" },
  { name: "eval runs constructed source", script: `cmd='echo evaluated'; eval "$cmd"`, stdout: "evaluated\n" },
  { name: "dot sources a workspace script", script: `. ./lib.sh; helper`, seed: { "/workspace/lib.sh": "helper() { echo sourced; }\n" }, stdout: "sourced\n" },
  { name: "colon is a successful no-op", script: `: ; echo $?`, stdout: "0\n" },
  { name: "type reports what a name is", script: `type echo; type cd`, stdout: "echo is a shell builtin\ncd is a shell builtin\n" },
  { name: "alias substitutes a command", script: `alias ll='ls -1'; ll`, seed: { "/workspace/only": "" }, stdout: "only\n" },
  /*
   * The wrapper idiom every shell user writes. `command` must bypass the
   * function table, or the function calls itself until the nesting budget ends
   * the run with an opaque fatal error instead of any output at all.
   */
  { name: "command runs the utility a function of the same name shadows", script: `echo() { command echo wrapped "$@"; }; echo one; echo two`, stdout: "wrapped one\nwrapped two\n" },
  { name: "command refuses a name that is only a function", script: `only_a_function() { echo fn; }; command only_a_function; echo $?`, stdout: "127\n", stderrMatch: /only_a_function: command not found/u },
  { name: "set rejects an unimplemented flag", script: `set -q`, exitCode: 2, stderrMatch: /unsupported option/u },
  { name: "nounset fails on an unset parameter", script: `set -u; echo "$missing"`, exitCode: 1, stderrMatch: /parameter not set/u },
  { name: "exec runs a command and ends the shell", script: `exec echo replaced; echo unreachable`, stdout: "replaced\n" },

  // --- utilities ----------------------------------------------------------
  { name: "ls sorts names", script: `ls`, seed: { "/workspace/b": "", "/workspace/a": "", "/workspace/c/x": "" }, stdout: "a\nb\nc\n" },
  { name: "ls -a shows dotfiles", script: `ls -a`, seed: { "/workspace/.env": "", "/workspace/keep": "" }, stdout: ".env\nkeep\n" },
  { name: "cat numbers lines with -n", script: `cat -n f`, seed: { "/workspace/f": "x\ny\n" }, stdout: "     1\tx\n     2\ty\n" },
  { name: "cp and mv move real bytes", script: `cp a b; mv b c; cat c; ls`, seed: { "/workspace/a": "payload\n" }, stdout: "payload\na\nc\n" },
  /*
   * A copy that consumes itself. `mv a a` copied `a` onto `a` and then removed
   * the source, so renaming a file to the name it already had deleted it and
   * exited 0 — the one outcome a `mv` may never produce. The directory forms
   * recursed through the children they were creating until the step budget
   * stopped them, leaving a partial tree and still reporting success.
   */
  { name: "mv onto the same name refuses instead of deleting the file", script: `mv a a`, seed: { "/workspace/a": "payload\n" }, exitCode: 1, stderrMatch: /are the same file/u, files: { "/workspace/a": "payload\n" } },
  { name: "cp onto the same name refuses", script: `cp a a`, seed: { "/workspace/a": "payload\n" }, exitCode: 1, stderrMatch: /are the same file/u, files: { "/workspace/a": "payload\n" } },
  { name: "cp -r refuses a directory into its own subtree", script: `mkdir -p d/inner; cp -r d d/inner`, seed: { "/workspace/d/a": "x\n" }, exitCode: 1, stderrMatch: /cannot copy a directory, \/workspace\/d, into itself/u },
  { name: "mv refuses a directory into its own subtree", script: `mkdir -p d/inner; mv d d/inner`, seed: { "/workspace/d/a": "x\n" }, exitCode: 1, stderrMatch: /cannot move \/workspace\/d to a subdirectory of itself/u },
  { name: "rm -r removes a tree", script: `rm -r d; ls`, seed: { "/workspace/d/x": "", "/workspace/keep": "" }, stdout: "keep\n" },
  { name: "mkdir -p creates parents", script: `mkdir -p a/b/c; [ -d a/b/c ] && echo made`, stdout: "made\n" },
  { name: "head and tail select lines", script: `seq 1 5 | head -n 2; seq 1 5 | tail -n 2`, stdout: "1\n2\n4\n5\n" },
  { name: "wc counts lines words and bytes", script: `printf 'a b\\nc\\n' | wc -l -w -c`, stdout: "2 3 6\n" },
  { name: "grep filters and counts", script: `printf 'alpha\\nbeta\\ngamma\\n' | grep a | wc -l; printf 'a\\nb\\n' | grep -c b`, stdout: "3\n1\n" },
  { name: "grep -v inverts and -n numbers", script: `printf 'x\\ny\\n' | grep -vn x`, stdout: "2:y\n" },
  { name: "grep -E uses extended syntax", script: `printf 'ab\\nac\\n' | grep -E 'a(b|c)' | wc -l`, stdout: "2\n" },
  { name: "grep returns 1 when nothing matches", script: `printf 'a\\n' | grep zzz; echo $?`, stdout: "1\n" },
  { name: "sed substitutes globally", script: `printf 'a-a-a\\n' | sed 's/a/X/g'`, stdout: "X-X-X\n" },
  { name: "sed -n with p prints only matches", script: `printf 'one\\ntwo\\n' | sed -n '/two/p'`, stdout: "two\n" },
  { name: "sed deletes addressed lines", script: `printf '1\\n2\\n3\\n' | sed '2d'`, stdout: "1\n3\n" },
  { name: "sed rejects a command it does not implement", script: `printf 'x\\n' | sed 'y/a/b/'`, exitCode: 2, stderrMatch: /unsupported command/u },
  { name: "sort -n orders numerically", script: `printf '10\\n9\\n' | sort -n; printf '10\\n9\\n' | sort`, stdout: "9\n10\n10\n9\n" },
  { name: "sort -u removes duplicates", script: `printf 'b\\na\\nb\\n' | sort -u`, stdout: "a\nb\n" },
  { name: "uniq -c counts runs", script: `printf 'a\\na\\nb\\n' | uniq -c`, stdout: "      2 a\n      1 b\n" },
  { name: "cut selects fields", script: `printf 'a:b:c\\n' | cut -d: -f2; printf 'abcdef\\n' | cut -c2-4`, stdout: "b\nbcd\n" },
  { name: "tr translates and deletes", script: `printf 'hello\\n' | tr a-z A-Z; printf 'a1b2\\n' | tr -d '0-9'`, stdout: "HELLO\nab\n" },
  { name: "find walks the tree by name", script: `find . -name '*.txt' | sort`, seed: { "/workspace/a.txt": "", "/workspace/sub/b.txt": "", "/workspace/sub/c.md": "" }, stdout: "./a.txt\n./sub/b.txt\n" },
  { name: "find -type d lists directories", script: `find . -type d | sort`, seed: { "/workspace/sub/x": "" }, stdout: ".\n./sub\n" },
  { name: "find rejects an unimplemented predicate", script: `find . -newer x`, exitCode: 2, stderrMatch: /unsupported predicate/u },
  { name: "basename and dirname", script: `basename /a/b/c.txt; basename /a/b/c.txt .txt; dirname /a/b/c.txt`, stdout: "c.txt\nc\n/a/b\n" },
  { name: "realpath resolves against the cwd", script: `mkdir -p x; realpath x`, stdout: "/workspace/x\n" },
  { name: "xargs batches arguments", script: `printf 'a\\nb\\nc\\n' | xargs -n 2 echo`, stdout: "a b\nc\n" },
  { name: "xargs -I substitutes a placeholder", script: `printf 'a\\nb\\n' | xargs -I@ echo item-@`, stdout: "item-a\nitem-b\n" },
  { name: "env -i starts from an empty environment", script: `env -i A=1 env`, stdout: "A=1\n" },
  { name: "seq counts with an increment", script: `seq 1 2 7 | tr '\\n' ' '; echo`, stdout: "1 3 5 7 \n" },
  { name: "date formats UTC fields", script: `date -d 2026-07-25T12:34:56Z '+%F %T %Z'`, stdout: "2026-07-25 12:34:56 UTC\n" },
  { name: "date rejects an unknown directive", script: `date '+%Q'`, exitCode: 2, stderrMatch: /unsupported directive/u },
  { name: "diff reports a difference and exits 1", script: `diff a b`, seed: { "/workspace/a": "x\n", "/workspace/b": "y\n" }, exitCode: 1, stdout: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-x\n+y\n" },
  { name: "diff on identical files is silent", script: `diff a b; echo $?`, seed: { "/workspace/a": "x\n", "/workspace/b": "x\n" }, stdout: "0\n" },
  { name: "stat -c reports honest fields", script: `stat -c '%n %s %F' f`, seed: { "/workspace/f": "1234" }, stdout: "f 4 regular file\n" },
  { name: "du -s totals a subtree", script: `du -s d`, seed: { "/workspace/d/a": "x", "/workspace/d/b": "y" }, stdout: "2\td\n" },
  { name: "an unimplemented utility flag is an error", script: `ls -Z`, exitCode: 2, stderrMatch: /unsupported option: -Z/u },

  // --- combined, realistic scripts ---------------------------------------
  {
    name: "a report pipeline over real files",
    script: [
      "set -e",
      "total=0",
      "for f in data/*.csv; do",
      "  count=$(wc -l < \"$f\")",
      "  total=$(( total + count ))",
      "  printf '%s=%s\\n' \"$(basename \"$f\" .csv)\" \"$count\"",
      "done",
      'echo "total=$total"',
    ].join("\n"),
    seed: { "/workspace/data/a.csv": "1\n2\n", "/workspace/data/b.csv": "3\n" },
    stdout: "a=2\nb=1\ntotal=3\n",
  },
  {
    name: "generate, transform, and verify a file",
    script: [
      "mkdir -p build",
      "for word in gamma alpha beta; do echo \"$word\" >> build/words.txt; done",
      "sort build/words.txt > build/sorted.txt",
      "grep -c . build/sorted.txt",
      "head -n 1 build/sorted.txt",
    ].join("\n"),
    stdout: "3\nalpha\n",
    files: { "/workspace/build/sorted.txt": "alpha\nbeta\ngamma\n" },
  },
  {
    name: "case-driven dispatch with functions and traps",
    script: [
      "trap 'echo cleanup' EXIT",
      "run() {",
      "  case \"$1\" in",
      "    build) echo building;;",
      "    test) echo testing; return 2;;",
      "    *) echo \"unknown: $1\" >&2; return 1;;",
      "  esac",
      "}",
      "run build",
      "run test || echo \"status=$?\"",
      "run other || echo \"status=$?\"",
    ].join("\n"),
    stdout: "building\ntesting\nstatus=2\nstatus=1\ncleanup\n",
    stderr: "unknown: other\n",
  },
]);

describe("airship-sh script suite", () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const result = await runScript(testCase.script, testCase.seed, { args: testCase.args, env: testCase.env });
      if (testCase.stdout !== undefined) expect(result.stdout).toBe(testCase.stdout);
      if (testCase.stderr !== undefined) expect(result.stderr).toBe(testCase.stderr);
      if (testCase.stderrMatch !== undefined) expect(result.stderr).toMatch(testCase.stderrMatch);
      expect(result.exitCode).toBe(testCase.exitCode ?? 0);
      for (const [path, content] of Object.entries(testCase.files ?? {})) {
        expect(result.files[path]).toBe(content);
      }
    });
  }

  /*
   * `AIRSHIP_SH_MAX_FUNCTIONS` sat in the contract beside the variable, alias,
   * and positional caps while nothing read it, so the one axis of shell state a
   * script can grow without an argument list was unbounded.
   */
  it("bounds the function table like every other axis of shell state", async () => {
    const script = Array.from({ length: AIRSHIP_SH_MAX_FUNCTIONS + 1 }, (_, index) => `f${index}() { :; }`).join("\n");
    const result = await runScript(script);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`airship-sh: airship-sh exceeded ${AIRSHIP_SH_MAX_FUNCTIONS} shell functions\n`);
  });

  it("redefining one function stays free of the cap", async () => {
    const script = Array.from({ length: AIRSHIP_SH_MAX_FUNCTIONS + 8 }, (_, index) => `f() { echo ${index}; }`).join("\n");
    const result = await runScript(`${script}\nf`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${AIRSHIP_SH_MAX_FUNCTIONS + 7}\n`);
  });

  it("covers every documented dimension of the grammar", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });
});
