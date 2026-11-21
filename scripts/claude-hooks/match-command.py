#!/usr/bin/env python3
"""Classify a shell command as 'commit', 'deploy', or neither.

A naive substring search is wrong here, and wrong in the direction that makes
hooks unusable: the words "git" and "commit" appear constantly inside heredoc
bodies, quoted strings and documentation being written *by* a command. The
first version of this hook refused a call that was merely writing a markdown
file describing git usage.

So: strip heredoc bodies and quoted strings first, then require the verb to sit
at a command position (start of input, or after ; & | && || newline ( { ) —
where a shell would actually parse it as the command being run.
"""
import re, sys

HEREDOC = re.compile(r'<<-?\s*(["\']?)([A-Za-z_][A-Za-z0-9_]*)\1')

def strip_heredocs(s):
    out, i = [], 0
    while True:
        m = HEREDOC.search(s, i)
        if not m:
            out.append(s[i:]); break
        out.append(s[i:m.end()])
        # Body runs to a line consisting of the delimiter (allowing <<- indent).
        rest = s[m.end():]
        nl = rest.find('\n')
        if nl == -1:
            break
        body = rest[nl + 1:]
        end = re.search(r'^\s*' + re.escape(m.group(2)) + r'\s*$', body, re.M)
        i = m.end() + nl + 1 + (end.end() if end else len(body))
    return ''.join(out)

def strip_quotes(s):
    # Drop single-quoted spans wholesale; they cannot contain a live command.
    s = re.sub(r"'[^']*'", " ", s)
    # Double-quoted spans can contain $( ) — keep those, drop the rest.
    return re.sub(r'"(?:[^"$\\]|\\.)*"', " ", s)

# A command position: start, or right after a separator. Quote characters
# count too, so an ssh payload (ssh host "systemctl restart ...") is seen.
CMDPOS = r'(?:^|[\n;&|(){\'"])\s*'
# Options may take a value (git -C <dir> commit), so allow an optional
# argument after each flag; backtracking keeps `commit` itself unconsumed.
COMMIT = re.compile(CMDPOS + r'(?:sudo\s+)?git\b(?:\s+-\S+(?:\s+\S+)?)*\s+commit\b')
# `npm run feature -- set <switch> on|off <scope> --live`, or the file run
# directly (`node --import tsx src/feature-cli.ts set …`). `set` must be the verb
# right after the tool, and --live a whole flag (not --live-run, not --livelier).
# Quoted arguments are skipped whole, so a `;` or `|` inside `--trip 'a;b'`
# cannot hide the flag that follows it.
# npm's own spellings of "run this script in that directory": `--prefix dir`,
# `--prefix=dir` and `-C dir`, before `run` or after the script name, and
# `run-script` for `run`.
_NPM_DIR = r"(?:--prefix(?:=|\s+)\S+|-C\s+\S+)"
# Any other npm flag (`--silent`, `-s`, `--loglevel=warn`) may sit there too, and the
# script still runs: `npm run --silent feature -- set … --live` was classified `none`
# until 2026-11-20, and it is the spelling the VM runbook uses.
_NPM_OPT = r"(?:" + _NPM_DIR + r"|--?[A-Za-z][\w-]*(?:=\S+)?)"
# The flag may itself be quoted (`"--live"`, `'--live'`): the shell strips the
# quotes and the CLI sees the same argv.
FEATURE_SET_LIVE = (
    r'\b(?:npm\s+(?:' + _NPM_OPT + r'\s+)*run(?:-script)?(?:\s+' + _NPM_OPT + r')*\s+feature(?:\s+' + _NPM_DIR + r')*'
    r'|feature-cli(?:\.[jt]s)?)'
    r'\s+(?:--\s+)?set\b(?:\'[^\']*\'|"[^"]*"|[^\n;&|\'"])*?\s["\']?--live(?![\w-])')
# The same change by HTTP: a request to the admin route whose body says
# "live": true (any whitespace, JSON-escaped quotes when it sits inside ssh "…"),
# on the line or its backslash-continuations. A body this hook cannot read — read
# from a file or stdin (-d @file, --data-binary @-, a heredoc stripped before this
# runs) — is asked too: it might say live, and asking costs one keystroke.
_LINE = r'(?:[^\n]|\\\n)*'
FEATURE_ROUTE_LIVE = (
    r'(?m:^(?=' + _LINE + r'/v1/admin/feature-switches)'
    r'(?:(?=' + _LINE + r'\\*"live\\*"\s*:\s*true\b)'
    r'|(?=' + _LINE + r'(?:-d|--data(?:-binary|-raw|-urlencode)?|--json)(?:\s+|=)@)))')
# Every deploy verb is one of two kinds (owner's standing approval, 2026-11-20):
#
#   ROUTINE_DEPLOY — what the lead session runs to get a change to a trip: a trip's
#     own deploy wrapper, a site restart, a bridge restart, promoting a release, a
#     feature switch on one trip or on future trips. Each has a way back (the
#     previous release, the switch off, the same command again).
#   ASKING_DEPLOY — everything else: hard rule 7 (a container removed, stopped or
#     recreated), anything that deletes data or a way back, the VM's version
#     (whose migration may be `breaking`, which the hook cannot see), every-trip
#     switches, and whole-host operations.
#
# The split is an ALLOW-LIST: a verb is routine only by being named here. Anything
# added to the asking half later, or matched by neither, keeps asking. Both halves
# are joined into DEPLOY below, so classification itself is unchanged; only
# `--deploy-class` reads the split, and pretooluse-bash.sh uses it only when the
# owner's opt-in is set (CLAUDE.md hard rule 2).
ROUTINE_DEPLOY = (
    # The per-trip wrappers and the Mac stack's sidecar. preflight-deploy.sh matches
    # here too (it ends in deploy.sh); its --deploy deploys the checkout to staging.
    CMDPOS + r'(?:sudo\s+)?(?:bash\s+|sh\s+)?\S*(?:deploy\.sh|bring-up\.sh|deploy-trip\.sh)\b'
    r'|' + CMDPOS + r'(?:sudo\s+)?systemctl\s+restart\s+trip-server\b'
    r'|\S*(?:vm-release\.py|kinerary-cp-release)\b(?![^\n;&|]*--dry-run\b)[^\n;&|]*\brestart-bridges\b'
    # Promoting a release to 'available' ships code. That is the pool
    # generatePlan() selects from, so from this moment every trip built or
    # rebuilt runs this tree — while trips already provisioned stay on the
    # release they were pinned to. The earlier hops (candidate -> verified)
    # are checkpoints and reach nobody, so only 'available' prompts.
    r'|' + CMDPOS + r'[^\n;&|]*\brelease\b[^\n;&|]*\bpromote\b[^\n;&|]*--to[=\s]+available\b'
    # A feature switch set with --live (#567): it changes what trips in use do,
    # and for the every-trip and future-trips scopes it is required. Anywhere on
    # the line, because it is run through ssh. Without --live the command only
    # touches a test trip (or the command refuses), and `list`/`show` read, so
    # those stay prompt-free. pretooluse-bash.sh words the prompt for it. With
    # --all it is ASKING_DEPLOY as well (below), so it always asks.
    r'|' + FEATURE_SET_LIVE)
# --all on a `feature set`: every trip, the families' trips in use included.
FEATURE_SET_ALL = (
    r'\b(?:npm\s+(?:' + _NPM_OPT + r'\s+)*run(?:-script)?(?:\s+' + _NPM_OPT + r')*\s+feature(?:\s+' + _NPM_DIR + r')*'
    r'|feature-cli(?:\.[jt]s)?)'
    r'\s+(?:--\s+)?set\b(?:\'[^\']*\'|"[^"]*"|[^\n;&|\'"])*?\s["\']?--all(?![\w-])')
ASKING_DEPLOY = (
    # Retargeting points a container at another trip and replaces what it serves.
    CMDPOS + r'(?:sudo\s+)?(?:bash\s+|sh\s+)?\S*retarget-container\.sh\b'
    # `compose up` recreates whatever changed, and the hook cannot tell which
    # stack (a shared one, hard rule 7) it reaches.
    r'|' + CMDPOS + r'(?:sudo\s+)?docker[ -]compose\b[^\n;&|]*\bup\b'
    r'|' + CMDPOS + r'(?:sudo\s+)?docker\s+restart\b'
    # Hard rule 7: removing, stopping or recreating a container is Dror's call,
    # every time. On 2026-11-09 a verifier ran `docker rm -f` on the test
    # Postgres every session shares, to get a "fresh" one. `docker exec … psql`
    # (creating or dropping your own cptest_* database inside it) stays quiet.
    r'|' + CMDPOS + r'(?:sudo\s+)?docker\s+(?:container\s+)?(?:rm|stop|kill)\b'
    r'|' + CMDPOS + r'(?:sudo\s+)?docker[ -]compose\b[^\n;&|]*\s(?:down|rm|stop|kill|restart)\b'
    r'|\bforce-recreate\b'
    # Tearing a trip down (container, DNS, proxy host, profile) is at least as
    # live as deploying one. Only --execute: its dry run is read-only, and a
    # prompt that fires on read-only commands teaches people to click through.
    r'|' + CMDPOS + r'(?:sudo\s+)?(?:python3?\s+)?\S*teardown-trip\.py\b[^\n;&|]*--execute\b'
    # The production control plane's release tool: every verb that moves the
    # running version, the database, or deletes a way back. Anywhere on the line,
    # not only at a command position, because it is run through ssh ("ssh <host>
    # sudo kinerary-cp-release upgrade …"). Its --dry-run, and status/plan/verify,
    # stay prompt-free. `upgrade` stays here: a migration in it may be `breaking`
    # (a missing header reads as breaking), and only the dry run can say so.
    r'|\S*(?:vm-release\.py|kinerary-cp-release)\b(?![^\n;&|]*--dry-run\b)[^\n;&|]*'
    r'\b(?:upgrade|rollback|prune|install)\b'
    # Whole-VM restore is plan-only unless --execute.
    r'|\S*vm-restore-snapshot\.sh\b[^\n;&|]*--execute\b'
    # Proxmox guest state. A snapshot freezes the guest's filesystems, a
    # rollback discards data, an unlock clears the lock a stuck task left. Read
    # verbs (listsnapshot, config, guest cmd …-status) do not match.
    r'|\bqm\s+(?:snapshot|rollback|delsnapshot|unlock)\b'
    # A vzdump into an NFS share froze the host's storage VM, every NFS mount and
    # the control-plane VM on 2026-09-13; any vzdump, direct or over ssh, is a
    # question for a person.
    r'|(?:' + CMDPOS + r'|\bssh\b[^\n;&|]*\s)(?:sudo\s+)?vzdump\b'
    # The admin route's body may be read from a file or stdin, so its scope is unknown.
    r'|' + FEATURE_ROUTE_LIVE)
DEPLOY = re.compile(ROUTINE_DEPLOY + r'|' + ASKING_DEPLOY)
# --all is not a deploy by itself (without --live the command refuses), so it joins
# only the asking side, never the classification.
ASKING = re.compile(ASKING_DEPLOY + r'|' + FEATURE_SET_ALL)

# A commit by another name. Each of these creates or rewrites commits on the
# current branch, so each is hard rule 1 by a route on which the word "commit"
# never appears: a merge lands a whole branch at once; cherry-pick and revert
# write new commits; rebase and am rewrite or append them; `gh pr merge` does
# the merge on GitHub, where no local git hook runs at all. Verified
# 2026-09-20: every one of them classified as `none`, so an integrator agent
# with Bash could have landed work on the integration branch with no prompt.
#
# The read-only relatives stay quiet, because a prompt on a read teaches people
# to click through: merge-tree and merge-base compute, --abort and --quit undo,
# `gh pr view/diff/checks` read. `(?![\w-])` is what keeps `merge-tree` out.
MERGE = re.compile(
    CMDPOS + r'(?:sudo\s+)?git\b(?:\s+-\S+(?:\s+\S+)?)*\s+(?:merge|cherry-pick|revert|rebase|am)(?![\w-])'
    r'(?![^\n;&|]*--(?:abort|quit)\b)'
    r'|' + CMDPOS + r'gh\s+pr\s+merge\b')
# Pushing publishes. After it the commits exist for everyone who fetches, and a
# force push rewrites what they already had.
PUSH = re.compile(CMDPOS + r'(?:sudo\s+)?git\b(?:\s+-\S+(?:\s+\S+)?)*\s+push(?![\w-])')

# One rollout is one approval (CLAUDE.md, "Faster delivery", 2026-11-14), so the
# command that IS the rollout and each step it runs on its own are all deploys.
# Until this list, a bridge restart, a prompt refresh and a gateway stop/start
# were never asked at all (#568); now they are, and the prompt for the command
# that covers them all names the commit, the trips and the steps.
#
# Kept apart from DEPLOY, and joined to it only at the dispatch below, so the
# two lists are edited without touching each other's lines.
#
#   * `trip-rollout.py execute` — and only `execute`, as the first word after the
#     script: `plan` and `status` read, and `--plan-file …/execute.json` is a name.
#   * the bridge restart (`setup-mcp.sh --restart-only`, and the generic wrappers
#     `restart-trip-mcp.sh` / `restart-all-trip-mcp.sh`), the prompt refresh
#     (`companion-refresh-prompts.sh`, whose own `--dry-run` reads) and a Hermes
#     gateway stop/start/restart, which cuts a family's companion off mid-turn.
#
# A step counts only when it is THE COMMAND BEING RUN. Unlike DEPLOY (whose entries
# are matched with quotes intact, because a real deploy is routinely an ssh payload),
# this is matched with quoted text removed, so a commit message that begins with a
# step's words, or a `grep "setup-mcp.sh --restart-only" docs`, is not one. The
# places a command legitimately sits inside quotes — an ssh payload, `docker exec`,
# `sh -c` — are read separately, as the command they carry (embedded_commands).
ROLL_CMDPOS = r'(?:^|[\n;&|(){`])\s*'
ENVWORDS = r'(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*'
STEPPOS = ROLL_CMDPOS + ENVWORDS + r'(?:sudo\s+(?:-\S+\s+)*)?'
ROLLOUT = re.compile(
    STEPPOS + r'(?:python3?(?:\s+-\S+)*\s+)?\S*trip-rollout\.py\s+execute(?=[\s;&|)]|$)'
    r'|' + STEPPOS + r'(?:bash\s+|sh\s+)?\S*setup-mcp\.sh\b[^\n;&|]*--restart-only\b'
    r'|' + STEPPOS + r'(?:bash\s+|sh\s+)?\S*restart-(?:all-)?trip-mcp\.sh\b'
    r'|' + STEPPOS + r'(?:bash\s+|sh\s+)?\S*companion-refresh-prompts\.sh\b(?![^\n;&|]*--dry-run\b)'
    r'|' + STEPPOS + r'(?:\S*/)?hermes\b[^\n;&|]*\bgateway\s+(?:stop|start|restart)\b'
    r'|' + STEPPOS + r'launchctl\s+(?:kickstart|bootout|bootstrap|unload|load|stop|start|kill)\b[^\n;&|]*hermes\.gateway')

SSH_VALUE_OPTIONS = {"-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q",
                     "-R", "-S", "-W", "-w"}
DOCKER_EXEC_VALUE_OPTIONS = {"-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file", "--detach-keys"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}


def _statements(text):
    """The words of each simple command in `text`, quotes resolved the way a shell
    resolves them. None when the text cannot be read as words."""
    import shlex
    lex = shlex.shlex(text.replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        words = list(lex)
    except ValueError:
        return None
    statements, current = [], []
    for w in words:
        if set(w) <= set("();<>|&"):
            if current:
                statements.append(current)
            current = []
        else:
            current.append(w)
    if current:
        statements.append(current)
    return statements


def _command_start(words):
    """Index of the program in `words`, past VAR=value words and sudo (with its options)."""
    i = 0
    while i < len(words) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', words[i]):
        i += 1
    if i < len(words) and words[i] == "sudo":
        i += 1
        while i < len(words) and words[i].startswith("-"):
            i += 2 if words[i] in ("-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T") else 1
    return i


def _skip_options(words, value_options):
    """Drop leading options (and the values of those that take one); return the rest."""
    i = 0
    while i < len(words) and words[i].startswith("-") and words[i] != "-":
        i += 2 if (words[i] in value_options and "=" not in words[i]) else 1
    return words[i:]


def embedded_commands(raw):
    """Commands carried as a PAYLOAD of another command: what an ssh host is told to
    run, what `docker exec <container>` runs, what `sh -c` is given. Each is returned as
    the string the far end's shell would read. `ssh host grep "x" f` carries `grep x f`
    — a search, not a step — which is the point of reading them as words."""
    found = []
    for words in _statements(raw) or []:
        start = _command_start(words)
        if start >= len(words):
            continue
        head, rest = words[start].rsplit("/", 1)[-1], words[start + 1:]
        if head == "ssh":
            rest = _skip_options(rest, SSH_VALUE_OPTIONS)
            if len(rest) > 1:                      # rest[0] is the host
                found.append(" ".join(rest[1:]))
        elif head == "docker":
            sub = rest[:2] if rest[:1] == ["container"] else rest[:1]
            if sub in (["exec"], ["container", "exec"]):
                rest = _skip_options(rest[len(sub):], DOCKER_EXEC_VALUE_OPTIONS)
                if len(rest) > 1:                  # rest[0] is the container; it execs an argv, no shell
                    import shlex
                    found.append(shlex.join(rest[1:]))
        if head in SHELLS:
            for k, w in enumerate(words):
                if re.match(r'^-[A-Za-z]*c$', w) and k + 1 < len(words):
                    found.append(words[k + 1])
    return found


def rollout_hit(raw, depth=0):
    if ROLLOUT.search(strip_quotes(raw)):
        return True
    if depth < 3:
        return any(rollout_hit(payload, depth + 1) for payload in embedded_commands(raw))
    return False

# --normalize: rewrite the inert shapes sessions actually type into the plain form
# the hook's exemptions match (2026-09-26, from the decision log: 8 of 9 prompts
# in 90 minutes were for commits the exemptions meant to allow). Only two things
# are rewritten, and both are inert:
#   * a heredoc message with a QUOTED delimiter -- -m "$(cat <<'EOF' ... EOF)" --
#     whose body the shell passes through literally, becomes -m 'msg';
#   * a trailing output filter -- 2>&1, | tail -N, | head -N, | grep -v '<text>' --
#     is dropped: it only shapes what is printed, never what is committed.
# Anything else is left as it is, so it fails the exemption and is asked.
#
# The heredoc ends where the SHELL ends it: at the FIRST line equal to the
# delimiter. Anything after that line inside the $( ) is executed, so a message is
# rewritten only when its first terminator line is followed by nothing but the
# closing )". A terminator is recognised by the classifier's own looser rule
# (^\s*D\s*$, as strip_heredocs uses), so the two can never disagree about where a
# heredoc ends. Any anomaly leaves the whole command as typed, which then fails the
# exemption and is asked. (#242 review, 2026-09-26: a non-greedy regex read to the
# LAST delimiter and erased a hidden `git push --force origin main` as "body".)
HEREDOC_OPEN = re.compile(r'"\$\(cat <<[ \t]*([\'"])([A-Za-z_][A-Za-z0-9_]*)\1\n')
HEREDOC_CLOSE = re.compile(r'\s*\)"')
FILTER = (r'(?:\s*2>&1'
          r'|\s*\|\s*(?:tail|head)\s+-n?\s*\d+'
          r"|\s*\|\s*grep\s+-[vEiF]*v[vEiF]*\s+'[^'\n]*')")
TRAILING_FILTERS = re.compile(r'(?:' + FILTER + r')+\s*$')


def normalize_heredocs(cmd: str) -> str:
    out, i = [], 0
    while True:
        m = HEREDOC_OPEN.search(cmd, i)
        if not m:
            out.append(cmd[i:])
            return "".join(out)
        terminator = re.compile(r'^[ \t]*' + re.escape(m.group(2)) + r'[ \t]*$', re.M)
        end = terminator.search(cmd, m.end())
        if not end:
            return cmd                                  # never closed: leave it as typed
        close = HEREDOC_CLOSE.match(cmd, end.end())
        if not close:
            return cmd                                  # something runs after the heredoc
        out.append(cmd[i:m.start()])
        out.append("'msg'")
        i = close.end()


def normalize(cmd: str) -> str:
    cmd = cmd.strip()
    return TRAILING_FILTERS.sub("", normalize_heredocs(cmd)).strip()


if len(sys.argv) > 1 and sys.argv[1] == "--normalize":
    sys.stdout.write(normalize(sys.stdin.read()))
    sys.exit(0)

# --rollout-args: `execute`, then the three options of `trip-rollout.py execute` the
# approval prompt needs, one per line — the plan file, its digest, the narrowed steps
# (each empty when absent). Read with shlex from the one statement that runs the command, so what the
# prompt describes is what the shell will hand the script. Prints nothing when the
# command is not that, or cannot be read as words.
ROLLOUT_EXECUTE = re.compile(r'trip-rollout\.py\s+execute(?=[\s;&|"\')]|$)')
STATEMENT_END = re.compile(r'[;&|\n]')


def rollout_args(command: str):
    import shlex
    m = ROLLOUT_EXECUTE.search(strip_heredocs(command))
    if not m:
        return None
    tail = strip_heredocs(command)[m.end():]
    cut = STATEMENT_END.search(tail)
    tail = tail[:cut.start()] if cut else tail
    try:
        words = shlex.split(tail)
    except ValueError:
        # Run through ssh, the statement ends at the quote that closed the payload.
        try:
            words = shlex.split(tail.rstrip().rstrip("\"'"))
        except ValueError:
            return None
    found = {"--plan-file": "", "--plan-digest": "", "--steps": ""}
    i = 0
    while i < len(words):
        w = words[i]
        for opt in found:
            if w == opt and i + 1 < len(words):
                found[opt] = words[i + 1]
                i += 1
                break
            if w.startswith(opt + "="):
                found[opt] = w[len(opt) + 1:]
                break
        i += 1
    return found


if len(sys.argv) > 1 and sys.argv[1] == "--rollout-args":
    got = rollout_args(sys.stdin.read())
    if got:
        sys.stdout.write("execute\n" + "\n".join(got[o] for o in ("--plan-file", "--plan-digest", "--steps")) + "\n")
    sys.exit(0)

raw = strip_heredocs(sys.stdin.read())

# Asymmetric on purpose. Deploy verbs are matched with quotes intact, because a
# real deploy is routinely an ssh payload inside quotes; a spurious prompt costs
# one keystroke, while a missed deploy breaks hard rule 2. Commit is matched
# with quotes stripped, because "git commit" inside quotes is nearly always
# prose, and a spurious refusal there blocks real work.
# Merge and push follow commit's rule: quotes stripped, prose does not prompt.
# Order is by consequence, so `git push && deploy.sh` is a deploy and
# `git merge x && git commit` is a commit.
# --deploy-class: `routine` when the command is a deploy, every deploy verb in it is
# on the routine list, and nothing in it commits, merges or pushes; otherwise
# `asks` (also for a command that is not a deploy at all). Matched with quotes
# intact, like DEPLOY, so a protected verb inside an ssh payload is still seen.
if len(sys.argv) > 1 and sys.argv[1] == "--deploy-class":
    stripped = strip_quotes(raw)
    routine = ((DEPLOY.search(raw) or rollout_hit(raw))
               and not ASKING.search(raw)
               and not COMMIT.search(stripped) and not MERGE.search(stripped) and not PUSH.search(stripped))
    print("routine" if routine else "asks")
    sys.exit(0)

if DEPLOY.search(raw) or rollout_hit(raw):
    print("deploy")
elif COMMIT.search(strip_quotes(raw)):
    print("commit")
elif MERGE.search(strip_quotes(raw)):
    print("merge")
elif PUSH.search(strip_quotes(raw)):
    print("push")
else:
    print("none")
