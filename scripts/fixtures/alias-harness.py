"""Pipes, redirects, signal exits, verbatim argv and alias recursion."""
import pathlib,os,subprocess,json,tempfile,signal,time,sys,shlex,pty
ROOT=pathlib.Path(__file__).resolve().parents[2];CLI=json.loads(os.environ['TEST_GILD_COMMAND'])
with tempfile.TemporaryDirectory(dir=ROOT/'.tmp',prefix='alias-') as d:
    root=pathlib.Path(d);shim=root/'shim';native=root/'native';shim.mkdir();native.mkdir()
    agent=native/'claude';agent.write_text('#!/usr/bin/env python3\nimport sys,json,os,signal\nif "--die" in sys.argv:os.kill(os.getpid(),signal.SIGKILL)\nprint(json.dumps({"args":sys.argv[1:],"input":"" if "--no-input" in sys.argv else sys.stdin.read(),"tty":os.isatty(0),"chain":os.getenv("GILD_SPAWN_CHAIN"),"depth":os.getenv("GILD_SPAWN_DEPTH")}))\n');agent.chmod(0o755)
    wrapper=shim/'claude';wrapper.write_text('#!/bin/sh\nexec gild spawn claude "$@"\n');wrapper.chmod(0o755)
    env={**os.environ,'HOME':d,'PATH':str(shim)+os.pathsep+str(native)+os.pathsep+os.environ['PATH']}
    args=['--resume','-p','x','--name','belongs-to-agent','--','foo']
    p=subprocess.run(CLI+['spawn','claude']+args,input=b'pipe input',capture_output=True,env=env,timeout=5)
    assert p.returncode==0 and p.stderr==b'',p.stderr
    result=json.loads(p.stdout);assert result['args']==args,result;assert result['input']=='pipe input' and result['tty']==False
    assert not (root/'.gild/sessions').exists()
    p=subprocess.run(CLI+['spawn','claude','--die'],capture_output=True,env=env,timeout=5);assert p.returncode==137,p
    # A shell alias expands once; the PATH shim is skipped.
    import shlex
    command=' '.join(map(shlex.quote,CLI))
    alias=subprocess.run(['zsh','-c',f"alias claude='{command} spawn claude'\neval 'claude --version'"],input=b'',capture_output=True,env=env,timeout=5)
    assert alias.returncode==0 and alias.stderr==b'',alias.stderr
    assert json.loads(alias.stdout)['args']==['--version']
    # Redirected stdout with a real input TTY must still bypass PTY wrapping.
    master,slave=pty.openpty()
    try:
        with (root/'redirect.txt').open('wb') as output:
            redirected=subprocess.run(CLI+['spawn','claude','--no-input'],stdin=slave,stdout=output,stderr=subprocess.PIPE,env=env,timeout=5)
        assert redirected.returncode==0 and redirected.stderr==b''
        assert json.loads((root/'redirect.txt').read_text())['tty']==True
        assert not (root/'.gild/sessions').exists()
    finally:os.close(master);os.close(slave)
    # An opaque shim evades static detection but is skipped on marker-bearing re-entry.
    wrapper.write_text('#!/bin/sh\nexec "$GILD_TEST_RUNTIME" '+ ' '.join(map(shlex.quote,CLI[1:])) +' spawn claude "$@"\n')
    env['GILD_TEST_RUNTIME']=CLI[0];env.pop('GILD_SPAWN_DEPTH',None);env.pop('GILD_SPAWN_CHAIN',None)
    opaque=subprocess.run(CLI+['spawn','claude','--version'],input=b'',capture_output=True,env=env,timeout=5)
    assert opaque.returncode==0 and opaque.stderr==b'',opaque.stderr
    assert json.loads(opaque.stdout)['depth'] is None
    assert str(wrapper.resolve()) in json.loads(json.loads(opaque.stdout)['chain'])
    print(json.dumps({'passed':True,'alias':"alias claude='gild spawn claude'",'pipe':True,'signal_exit':137,'verbatim_args':True,'shim_skipped':True}))
