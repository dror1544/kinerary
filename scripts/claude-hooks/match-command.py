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
DEPLOY = re.compile(
    CMDPOS + r'(?:sudo\s+)?(?:bash\s+|sh\s+)?\S*(?:deploy\.sh|bring-up\.sh|deploy-trip\.sh|retarget-container\.sh)\b'
    r'|' + CMDPOS + r'(?:sudo\s+)?docker[ -]compose\b[^\n;&|]*\bup\b'
    r'|' + CMDPOS + r'(?:sudo\s+)?docker\s+restart\b'
    r'|\bforce-recreate\b'
    r'|' + CMDPOS + r'(?:sudo\s+)?systemctl\s+restart\s+trip-server\b')

raw = strip_heredocs(sys.stdin.read())

# Asymmetric on purpose. Deploy verbs are matched with quotes intact, because a
# real deploy is routinely an ssh payload inside quotes; a spurious prompt costs
# one keystroke, while a missed deploy breaks hard rule 2. Commit is matched
# with quotes stripped, because "git commit" inside quotes is nearly always
# prose, and a spurious refusal there blocks real work.
if DEPLOY.search(raw):
    print("deploy")
elif COMMIT.search(strip_quotes(raw)):
    print("commit")
else:
    print("none")
