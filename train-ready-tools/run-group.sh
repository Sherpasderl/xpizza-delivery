# run-group.sh: sourced by light-chain.sh (2e, 2026-11-16, advisor follow-up to portal light chain r0).
# rungroup <seconds> <cmd> [args…]
# Runs the command as the leader of its OWN process group. The command's rc passes through; a signal death gives 128+N.
# When the alarm fires, the WHOLE group is SIGKILLed and the rc is 124. When the leader exits, any children it left behind are
# killed too. The old `perl -e "alarm N; exec …"` killed only the top process, and its node --test children kept running as
# orphans (standing lesson: a timeout must kill the process group).
rungroup() {
  perl -e '
    my $t = shift;
    my $p = fork; defined $p or exit 125;
    if (!$p) { setpgrp(0, 0); exec @ARGV; exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$p; waitpid($p, 0); exit 124 };
    alarm $t;
    waitpid($p, 0); my $st = $?;
    alarm 0; kill "KILL", -$p;
    exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
  ' "$@"
}
