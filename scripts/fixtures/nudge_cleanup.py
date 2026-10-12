"""Bounded teardown for the watchdog fixture's exact owned launcher PID."""
import subprocess,time

def stop_owned(proc,drain,primary=None):
    if proc.poll() is not None:return
    try:
        proc.terminate()
        deadline=time.monotonic()+8
        while proc.poll() is None:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise subprocess.TimeoutExpired(proc.args,8)
            drain(min(.05,remaining))
        assert proc.returncode==143,('owned launcher SIGTERM result',proc.returncode)
    except BaseException as cleanup:
        # The grace deadline already failed. Stop only the exact child we started;
        # forced retirement never converts a failed shutdown into a passing check.
        if proc.poll() is None:
            try:proc.kill();proc.wait(timeout=2)
            except BaseException as retirement:
                if hasattr(cleanup,'add_note'):cleanup.add_note('Owned PID retirement also failed: '+repr(retirement))
        if primary is None:raise
        if hasattr(primary,'add_note'):primary.add_note('Watchdog cleanup also failed: '+repr(cleanup))
        else:
            import sys
            print('Watchdog cleanup also failed:',repr(cleanup),file=sys.stderr)
