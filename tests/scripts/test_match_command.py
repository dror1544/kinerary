"""scripts/claude-hooks/match-command.py — what becomes a commit/deploy prompt.

Hard rules 1 and 2 are about intent, so the hook's job is to make sure every
commit and every live change is a question put to a person. A miss here is
silent: the command just runs. Hence a table of the commands that matter.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "claude-hooks" / "match-command.py"


def classify(command: str) -> str:
    return subprocess.run([sys.executable, str(SCRIPT)], input=command, capture_output=True, text=True).stdout.strip()


class Classify(unittest.TestCase):
    def test_commits(self):
        self.assertEqual(classify("git commit -m 'x'"), "commit")
        self.assertEqual(classify("git -C some/dir commit -F -"), "commit")

    def test_prose_about_commits_is_not_a_commit(self):
        self.assertEqual(classify("cat > notes.md <<'EOF'\nnever git commit without approval\nEOF"), "none")

    def test_deploys(self):
        for command in (
            "~/kinerary-deploy/trips/japan-2026/deploy.sh",
            "docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait",
            "scripts/preflight-deploy.sh --deploy",
            "scripts/preflight-deploy.sh",  # every preflight prompts: safe direction, one keystroke
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_removing_stopping_or_recreating_a_container_is_asked(self):
        # Hard rule 7 (Dror, 2026-11-09): a verifier ran `docker rm -f` on the
        # test Postgres every session shares, to get a "fresh" one.
        for command in (
            "docker rm -f kinerary-sprint5-testdb",
            "docker rm -f kinerary-sprint5-testdb >/dev/null 2>&1; docker run -d --name kinerary-sprint5-testdb postgres:16",
            "docker container rm kinerary-sprint5-testdb",
            "docker stop kinerary-control-plane-local-api-1",
            "docker container stop x",
            "docker kill kinerary-sprint5-testdb",
            "docker restart kinerary-control-plane-local-worker-1",
            "docker compose -f control-plane/deployment/compose.local.yml down",
            "docker compose -f x.yml rm -f api",
            "docker compose stop worker",
            "sudo docker rm kinerary-sprint5-testdb",
            "ssh host \"docker stop trip-server\"",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_reading_containers_and_using_a_database_inside_one_is_not_asked(self):
        for command in (
            "docker ps -a",
            "docker logs --since 5m kinerary-control-plane-local-worker-1",
            "docker inspect -f '{{.State.StartedAt}}' x",
            "docker exec kinerary-sprint5-testdb psql -U postgres -c 'DROP DATABASE IF EXISTS cptest_x'",
            "docker exec kinerary-sprint5-testdb psql -U postgres -c 'CREATE DATABASE cptest_x'",
            "docker image rm-unused-is-not-a-verb",
            "cat > notes.md <<'EOF'\nnever docker rm a shared container\nEOF",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_a_teardown_that_executes_is_a_live_change(self):
        self.assertEqual(classify("scripts/teardown-trip.py --trip japan-2026 --execute"), "deploy")
        self.assertEqual(classify("cd x && python3 scripts/teardown-trip.py --trip trip_abc --execute"), "deploy")

    def test_promoting_a_release_to_available_is_a_deploy(self):
        # 'available' is the pool generatePlan() selects from, so this is the
        # moment a build starts reaching trips that have not been built yet.
        # The earlier hops are checkpoints and ship nothing.
        for command in (
            "npm run release -- promote rel_abc123 --to available",
            "npm run release -- promote rel_abc123 --to=available --actor operator:dror",
            "cd control-plane/api && npm run release -- promote rel_x --to available",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_the_earlier_promotion_hops_are_not_deploys(self):
        for command in (
            "npm run release -- promote rel_abc123 --to verified",
            "npm run release -- promote rel_abc123 --to deprecated",
            "npm run release -- list",
            "npm run release -- show rel_abc123",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_commits_by_another_name_are_merges(self):
        # Each creates or rewrites commits without the word "commit" appearing;
        # gh pr merge does it on GitHub where no local hook runs. All were
        # `none` until 2026-09-20 — an integrator agent could have landed work
        # on the integration branch unprompted.
        for command in (
            "git merge feat/x",
            "git merge --no-ff feat/x",
            "git merge --continue",
            "git -C /some/worktree merge feat/x",
            "gh pr merge 116 --squash",
            "cd x && gh pr merge 116 --merge --delete-branch",
            "git cherry-pick abc123",
            "git revert HEAD",
            "git rebase main",
            "git rebase --continue",
            "git am patches.mbox",
        ):
            self.assertEqual(classify(command), "merge", command)

    def test_read_only_merge_relatives_and_undo_do_not_prompt(self):
        for command in (
            "git merge-tree --write-tree integration/sprint-6 main",
            "git merge-base main HEAD",
            "git merge --abort",
            "git rebase --abort",
            "git cherry-pick --quit",
            "git revert --abort",
            "gh pr view 116 --json title",
            "gh pr diff 116",
            "gh pr checks 116",
            "cat > notes.md <<'EOF'\nrun git merge only after the report\nEOF",
            "echo 'git push origin main'",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_a_live_feature_switch_set_is_a_deploy(self):
        # #567 AC-9: a switch set with --live reaches trips in use.
        for command in (
            "npm run feature -- set delivery_probe on --all --live",
            "cd control-plane/api && npm run feature -- set delivery_probe off --trip japan-2026 --live",
            "npm run feature --prefix control-plane/api -- set delivery_probe on --new-trips --live",
            "npm --prefix control-plane/api run feature -- set delivery_probe on --all --live",
            "node --import tsx src/feature-cli.ts set delivery_probe on --live --all",
            "node dist/feature-cli.js set delivery_probe on --all --live=true",
            "npm run feature -- set delivery_probe on --trip 'a;b|c' --live",
            # review M2: other spellings that hand the CLI the same --live argv
            "npm run-script feature -- set delivery_probe on --all --live",
            "npm --prefix=control-plane/api run feature -- set delivery_probe on --all --live",
            "npm -C control-plane/api run feature -- set delivery_probe on --all --live",
            "npm run feature -- set delivery_probe on --all \"--live\"",
            "npm run feature -- set delivery_probe on --all '--live'",
            "npm --prefix=control-plane/api run-script feature --prefix=x -- set delivery_probe on --new-trips '--live'",
            # an HTTP POST to the admin route whose body carries "live": true
            "curl -s -X POST http://127.0.0.1:4310/v1/admin/feature-switches -H 'x-api-key: k' -d '{\"switch\":\"delivery_probe\",\"enabled\":true,\"scope\":\"all_trips\",\"live\":true}'",
            "curl -s -X POST http://127.0.0.1:4310/v1/admin/feature-switches -d '{\"live\" :   true, \"switch\":\"delivery_probe\"}'",
            "curl -s -d \"{\\\"live\\\": true}\" -X POST $BASE/v1/admin/feature-switches",
            "curl -X POST -d '{\"live\":true}' http://x/v1/admin/feature-switches?trip=a",
            "ssh host \"curl -s -X POST http://127.0.0.1:4310/v1/admin/feature-switches -d '{\\\"live\\\":true}'\"",
            # a body this hook cannot read: asked, because it might say live
            "curl -s -X POST http://127.0.0.1:4310/v1/admin/feature-switches -H 'x-api-key: k' --data-binary @body.json",
            "curl -s -X POST $BASE/v1/admin/feature-switches -d @- <<'EOF'\n{\"live\":true}\nEOF",
            "npm run feature -- set delivery_probe on --trip \"a&b\" --by 'x y' --live",
            "ssh host \"cd api && npm run feature -- set delivery_probe on --all --live\"",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_a_feature_switch_set_without_live_and_the_reads_are_silent(self):
        for command in (
            "npm run feature -- set delivery_probe on --trip staging-test-trip",
            "node --import tsx src/feature-cli.ts set delivery_probe off --trip staging-test-trip --by dror",
            "npm run feature -- list",
            "npm run feature -- show --trip japan-2026",
            "npm run feature -- show --trip japan-2026 --live",
            "npm run feature -- set delivery_probe on --trip x --live-run",
            "npm run-script feature -- show --trip japan-2026",
            "npm -C control-plane/api run feature -- set delivery_probe on --trip staging-test-trip",
            "curl -s -H 'x-api-key: k' http://127.0.0.1:4310/v1/admin/feature-switches?trip=japan-2026",
            "curl -s -X POST http://127.0.0.1:4310/v1/admin/feature-switches -d '{\"switch\":\"delivery_probe\",\"enabled\":true,\"scope\":\"trip\",\"trip\":\"t\",\"live\":false}'",
            "curl -s -X POST http://127.0.0.1:4310/v1/admin/trips/x/resume -d '{\"live\":true}'",
            "cat > notes.md <<'EOF'\nnpm run feature -- set delivery_probe on --all --live\nEOF",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_pushes(self):
        for command in (
            "git push origin HEAD",
            "git push --force-with-lease origin feat/x",
            "git -C /some/worktree push",
        ):
            self.assertEqual(classify(command), "push", command)

    def test_the_most_consequential_class_wins(self):
        self.assertEqual(classify("git merge feat/x && git commit -m 'resolve'"), "commit")
        self.assertEqual(classify("git push && ~/kinerary-deploy/trips/japan-2026/deploy.sh"), "deploy")
        self.assertEqual(classify("git fetch && git merge origin/main && git push"), "merge")

    def test_moving_a_trip_onto_the_gateway_or_rekeying_a_gateway_is_a_live_change(self):
        for command in (
            "scripts/trip-route.py --trip japan-2026 --set --execute",
            "scripts/trip-route.py --trip japan-2026 --clear --execute --live",
            "python3 scripts/trip-route.py --trip trip_abc --set --execute",
            "sudo KINERARY_DEPLOY_ROOT=/srv/deploy python3 scripts/trip-route.py --trip x --set --execute",
            "sudo env KINERARY_DEPLOY_ROOT=/srv/deploy python3 scripts/trip-route.py --trip x --set --execute",
            "cd x && KINERARY_DEPLOY_ROOT=/srv/d scripts/trip-route.py --trip x --set --execute",
            'ssh host "sudo python3 /opt/k/scripts/trip-route.py --trip x --set --execute"',
            "scripts/relay-rekey.py --all-enrolled --execute",
            "sudo python3 scripts/relay-rekey.py --profile a,b --execute",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_no_spelling_of_the_command_or_the_flag_gets_past_the_prompt(self):
        # Boundary review of #599 (2026-11-19, F1): each of these ran, or would run, the change with no prompt.
        for command in (
            "scripts/trip-route.py --trip x --set --exec --li",
            "scripts/trip-route.py --trip x --clear --e",
            "scripts/trip-route.py --trip x --set --exe\"\"cute",
            "scripts/trip-route.py --trip 'a;b' --set --execute",
            "python3 -u scripts/trip-route.py --trip x --set --execute",
            "python3.12 scripts/trip-route.py --trip x --set --execute",
            "/usr/bin/python3 scripts/trip-route.py --trip x --set --execute",
            "sudo -E python3 scripts/trip-route.py --trip x --set --execute",
            "timeout 60 scripts/trip-route.py --trip x --set --execute",
            "uv run scripts/relay-rekey.py --all-enrolled --execute",
            "scripts/relay-rekey.py --all-enrolled --exec",
            "scripts/teardown-trip.py --trip x --exec",
            "ssh host 'sudo -E /usr/bin/python3 /opt/k/scripts/trip-route.py --trip x --set --exec'",
            "bash -c 'timeout 9 python3 scripts/relay-rekey.py --all-enrolled --execute'",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_wrappers_comments_and_continuations_do_not_hide_the_flag(self):
        # Re-check of #599 (2026-11-20): forms the word reader alone missed.
        T = "python3 scripts/trip-route.py --trip x --set --execute --live"
        R = "python3 scripts/relay-rekey.py --all-enrolled --execute"
        for command in (
            "# move the test trip\nsudo KINERARY_DEPLOY_ROOT=/srv/d " + T,
            "curl -s http://h/#top >/dev/null; " + R,
            "python3 scripts/trip-route.py --trip a#b --set --execute",
            "X=a#b " + T,
            f"timeout 120 ssh host 'sudo {R}'",
            f"sshpass -f pw ssh host '{R}'",
            f"eval '{T}'",
            f"timeout 60 bash -c '{T}'",
            f"su root -c '{R}'",
            f"bash <<< '{T}'",
            f"echo '{R}' | sh",
            "python3 scripts/trip-route.py --trip x --set \\\n  --execute --live",
            "python3 scripts/TRIP-ROUTE.PY --trip x --set --execute",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_the_scripts_refuse_a_shortened_execute(self):
        root = Path(__file__).resolve().parents[2] / "scripts"
        for name in ("trip-route.py", "relay-rekey.py", "teardown-trip.py"):
            text = (root / name).read_text()
            self.assertIn("allow_abbrev=False", text, name)

    def test_showing_or_planning_a_route_or_a_rekey_is_read_only(self):
        for command in (
            "scripts/trip-route.py --trip japan-2026",
            "scripts/trip-route.py --trip japan-2026 --set",
            "sudo KINERARY_DEPLOY_ROOT=/srv/deploy python3 scripts/trip-route.py --trip x --clear",
            "scripts/relay-rekey.py --all-enrolled",
            "python3 -m unittest tests/scripts/test_trip_route.py",
            "grep -n -- --execute scripts/trip-route.py",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_a_teardown_dry_run_is_read_only(self):
        self.assertEqual(classify("scripts/teardown-trip.py --trip japan-2026"), "none")

    def test_ordinary_commands(self):
        self.assertEqual(classify("ls -la && git status"), "none")

    def test_control_plane_release_changes_are_live(self):
        # Upgrading, rolling back or pruning the production control plane moves
        # every live trip's bot and companion; prune deletes ways back.
        for command in (
            "sudo kinerary-cp-release upgrade 3a9f1c2",
            "kinerary-cp-release rollback --restore-db",
            "/usr/local/sbin/kinerary-cp-release prune",
            "sudo kinerary-cp-release install",
            "kinerary-cp-release restart-bridges",
            "control-plane/deployment/vm-release.py upgrade main",
            "sudo python3 /opt/kinerary/control-plane/deployment/vm-release.py rollback",
            "ssh debian@cp.example 'sudo kinerary-cp-release rollback'",
            "control-plane/deployment/vm-restore-snapshot.sh --snapshot pre-aa61f6e-202609161800 --execute",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_control_plane_release_reads_and_dry_runs_do_not_prompt(self):
        # A prompt on read-only commands teaches people to click through.
        for command in (
            "kinerary-cp-release status",
            "kinerary-cp-release plan main",
            "kinerary-cp-release verify",
            "sudo kinerary-cp-release upgrade 3a9f1c2 --dry-run",
            "kinerary-cp-release rollback --restore-db --dry-run",
            "kinerary-cp-release prune --dry-run",
            "control-plane/deployment/vm-restore-snapshot.sh --list",
            "control-plane/deployment/vm-restore-snapshot.sh --snapshot pre-aa61f6e-202609161800",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_proxmox_snapshot_state_changes_are_live(self):
        # A snapshot freezes the guest's filesystems; a rollback discards data;
        # a vzdump into an NFS share froze the host's storage VM, every NFS mount
        # and the control-plane VM on 2026-09-13. Each is a question for a person.
        for command in (
            "ssh root@pve.example qm snapshot 900 pre-x",
            "ssh root@pve.example 'qm rollback 900 pre-x'",
            "qm delsnapshot 900 pre-x --force",
            "qm unlock 900",
            "vzdump 901 --storage nas-share",
            "ssh root@pve.example \"vzdump 900 --storage local\"",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_proxmox_reads_do_not_prompt(self):
        for command in (
            "ssh root@pve.example qm listsnapshot 900",
            "qm config 900",
            "qm guest cmd 900 fsfreeze-status",
        ):
            self.assertEqual(classify(command), "none", command)


class Rollout(unittest.TestCase):
    """#568 / AC-10: one rollout is one approval, and the steps it runs are deploys on their own.

    Until now a bridge restart, a prompt refresh and a gateway stop/start were never asked at all.
    """

    def test_executing_a_rollout_is_a_deploy_however_it_is_run(self):
        for command in (
            "python3 scripts/trip-rollout.py execute --plan-file /tmp/p.json --plan-digest sha256:" + "0" * 64,
            "scripts/trip-rollout.py execute --plan-file p.json --plan-digest sha256:" + "0" * 64,
            "./scripts/trip-rollout.py execute --plan-file p.json",
            "python3 -I scripts/trip-rollout.py execute --plan-file p.json",
            "sudo python3 scripts/trip-rollout.py execute --plan-file p.json",
            "KINERARY_DEPLOY_ROOT=/x python3 scripts/trip-rollout.py execute --plan-file p.json",
            "cd /somewhere && python3 scripts/trip-rollout.py execute --plan-file p.json",
            "git status && python3 scripts/trip-rollout.py execute --plan-file p.json",
            "ssh host 'python3 scripts/trip-rollout.py execute --plan-file p.json'",
            "ssh host \"cd x && scripts/trip-rollout.py execute --plan-file p.json\"",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_planning_and_status_are_reads_and_stay_silent(self):
        for command in (
            "python3 scripts/trip-rollout.py plan --release rls_x --trip japan-2026 --plan-file /tmp/p.json",
            "scripts/trip-rollout.py status",
            "scripts/trip-rollout.py status --trip japan-2026",
            "scripts/trip-rollout.py --help",
            "scripts/trip-rollout.py plan --release x --trip a --plan-file /tmp/execute.json",  # a name, not the verb
            "python3 scripts/trip-rollout.py plan --release x --all --plan-file execute.json",
            "ls scripts/trip-rollout.py",
            "grep -n execute scripts/trip-rollout.py",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_each_step_run_on_its_own_is_a_deploy(self):
        for command in (
            # the bridge restart
            "cd ~/some-deployment && ./setup-mcp.sh --restart-only --trip-dir ./trips/a",
            "REPO_ROOT=$PWD KINERARY_DEPLOY_ROOT=/x ./setup-mcp.sh --restart-only --trip-dir ./trips/a",
            "bash setup-mcp.sh --restart-only --trip-dir t",
            "ssh host sudo ./setup-mcp.sh --restart-only --trip-dir t",
            # the prompt refresh
            "scripts/companion-refresh-prompts.sh japan2026",
            "bash scripts/companion-refresh-prompts.sh japan2026",
            "ssh host sudo scripts/companion-refresh-prompts.sh japan2026",
            # a gateway stop, start or restart
            "hermes -p japan2026 gateway stop",
            "hermes -p japan2026 gateway start",
            "hermes -p japan2026 gateway restart",
            "~/.local/bin/hermes -p japan2026 gateway start",
            "ssh host hermes -p japan2026 gateway stop",
            "docker exec -u 10000 hermes hermes -p japan2026 gateway restart",
            "cd x && hermes -p a gateway stop && hermes -p a gateway start",
            "launchctl kickstart -k gui/501/ai.hermes.gateway-japan2026",
            "launchctl bootout gui/501/ai.hermes.gateway-japan2026",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_reading_a_step_or_its_state_is_silent(self):
        for command in (
            "scripts/companion-refresh-prompts.sh --dry-run japan2026",
            "hermes -p japan2026 gateway status",
            "hermes gateway --help",
            "launchctl list | grep hermes",
            "ls scripts/companion-refresh-prompts.sh",
            "cat setup-mcp.sh",
            "grep -n restart-only setup-mcp.sh",
            "tail -n 50 ~/.hermes/profiles/japan2026/logs/agent.log",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_prose_that_merely_names_a_step_does_not_prompt_as_a_deploy(self):
        # A commit message, an issue body or an echo that mentions the commands is not running them.
        self.assertEqual(classify("echo see setup-mcp.sh --restart-only for details"), "none")
        self.assertEqual(classify("echo then hermes -p x gateway start by hand"), "none")
        self.assertEqual(classify("git commit -m 'the hook now asks before hermes -p x gateway start'"), "commit")
        self.assertEqual(classify("cat > notes.md <<'EOF'\nrun trip-rollout.py execute --plan-file p\nEOF"), "none")

    def test_a_commit_whose_message_starts_with_a_step_stays_a_commit(self):
        # Review round 1: a double-quoted message that BEGINS with a step's words read as a command position.
        for command in (
            'git commit -m "hermes gateway restart now asks"',
            'git commit -m "setup-mcp.sh --restart-only is now asked about"',
            'git commit -m "companion-refresh-prompts.sh asks too"',
            'git commit -m "trip-rollout.py execute is one approval"',
            'git commit -m "restart-trip-mcp.sh and restart-all-trip-mcp.sh ask"',
            "git commit -m 'hermes -p x gateway stop is asked'",
            "git commit -m \"$(cat <<'EOF'\nhermes gateway restart now asks\nEOF\n)\"",
        ):
            self.assertEqual(classify(command), "commit", command)

    def test_searching_for_or_printing_a_step_is_not_running_it(self):
        # A documentation sweep greps for these words; a subagent doing one must not be refused.
        for command in (
            'grep "setup-mcp.sh --restart-only" docs/runbook.md',
            "rg 'companion-refresh-prompts.sh' docs",
            "rg \"hermes -p x gateway stop\" docs",
            'git grep "hermes gateway restart" -- docs',
            'grep -rn "trip-rollout.py execute" docs scripts',
            'grep -n "restart-trip-mcp.sh" docs/runbook.md',
            'echo "hermes -p x gateway stop"',
            "printf 'setup-mcp.sh --restart-only\\n'",
            'sed -n 1,5p "companion-refresh-prompts.sh"',
            "cat docs/runbook.md | grep 'hermes gateway start'",
            "ssh host grep -n setup-mcp.sh --restart-only docs/x.md",
            "ssh host \"grep -n 'setup-mcp.sh --restart-only' docs/x.md\"",
            "docker exec hermes grep -rn 'gateway stop' /docs",
            'bash -c "grep -n setup-mcp.sh docs/x.md"',
        ):
            self.assertEqual(classify(command), "none", command)

    def test_a_step_that_really_runs_after_a_search_still_asks(self):
        self.assertEqual(classify('grep -rn "hermes gateway stop" docs && hermes -p a gateway stop'), "deploy")
        self.assertEqual(classify("echo done; ./setup-mcp.sh --restart-only --trip-dir t"), "deploy")

    def test_a_step_inside_a_shell_payload_is_still_a_deploy(self):
        for command in (
            'bash -c "hermes -p a gateway stop"',
            "sh -c 'cd x && ./setup-mcp.sh --restart-only --trip-dir t'",
            'ssh -i key -o BatchMode=yes host "cd x && ./setup-mcp.sh --restart-only --trip-dir t"',
            "ssh host 'scripts/companion-refresh-prompts.sh alpha'",
            'ssh host "sudo hermes -p a gateway restart"',
            "docker exec -u 10000 -e X=1 hermes sh -c 'hermes -p a gateway start'",
            'ssh host "ssh inner hermes -p a gateway stop"',
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_the_generic_bridge_restart_wrappers_are_deploys_and_reading_them_is_not(self):
        for command in (
            "./restart-trip-mcp.sh alpha-2026",
            "~/some-deployment/restart-all-trip-mcp.sh",
            "bash restart-trip-mcp.sh alpha-2026",
            "sudo ./restart-all-trip-mcp.sh",
            "cd ~/dep && ./restart-trip-mcp.sh a",
            "KINERARY_DEPLOY_ROOT=/x ./restart-all-trip-mcp.sh",
            "ssh host sudo ./restart-all-trip-mcp.sh",
            'ssh host "cd x && ./restart-trip-mcp.sh a"',
        ):
            self.assertEqual(classify(command), "deploy", command)
        for command in ("cat restart-trip-mcp.sh", "grep -n pid restart-all-trip-mcp.sh", "ls restart-trip-mcp.sh",
                        "bash -n restart-trip-mcp.sh"):
            self.assertEqual(classify(command), "none", command)

    def test_the_older_deploy_verbs_still_win_and_keep_their_class(self):
        self.assertEqual(classify("git push origin x && python3 scripts/trip-rollout.py execute --plan-file p"), "deploy")
        self.assertEqual(classify("docker restart trip-server"), "deploy")


class RolloutArgs(unittest.TestCase):
    """--rollout-args: what the prompt reads off the command is what the shell hands the script."""

    def args(self, command: str) -> list[str]:
        out = subprocess.run([sys.executable, str(SCRIPT), "--rollout-args"], input=command, capture_output=True, text=True).stdout
        return out.split("\n")[1:4] if out.startswith("execute\n") else []   # the first line marks "this is an execute"

    def test_the_three_options_are_read_in_order(self):
        self.assertEqual(
            ["/tmp/p.json", "sha256:" + "a" * 64, "site,bridge"],
            self.args("python3 scripts/trip-rollout.py execute --plan-file /tmp/p.json --plan-digest sha256:" + "a" * 64 + " --steps site,bridge"))

    def test_the_equals_form_and_quotes_are_read(self):
        self.assertEqual(["a b.json", "", ""], self.args("scripts/trip-rollout.py execute --plan-file='a b.json'"))
        self.assertEqual(["/p.json", "", ""], self.args("scripts/trip-rollout.py execute --plan-file \"/p.json\""))

    def test_only_the_statement_that_runs_the_command_is_read(self):
        self.assertEqual(["p.json", "", ""], self.args("scripts/trip-rollout.py execute --plan-file p.json ; echo --plan-digest nope"))
        self.assertEqual(["p.json", "", ""], self.args("cd x && scripts/trip-rollout.py execute --plan-file p.json | tee log"))

    def test_nothing_is_printed_for_a_command_that_is_not_an_execute(self):
        self.assertEqual([], self.args("scripts/trip-rollout.py plan --plan-file p.json"))
        self.assertEqual([], self.args("git status"))
        self.assertEqual([], self.args("scripts/trip-rollout.py execute --plan-file 'unterminated"))


if __name__ == "__main__":
    unittest.main()
