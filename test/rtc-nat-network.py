"""Two private LANs behind real Linux SNAT; caller owns an isolated network namespace."""
import os
import subprocess
import sys
import time

# Refuse direct execution: no host interface or firewall may be changed.
if len(sys.argv) != 5 or str(os.stat('/proc/self/ns/net').st_ino) == sys.argv[3]:
    raise RuntimeError('This test must run in a fresh isolated network namespace')

def run(*args, input=None):
    result = subprocess.run(args, input=input, text=True, timeout=10,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr[:4096]}')
    return result


def inside(pid, *args, input=None):
    return run('nsenter', '-t', str(pid), '-n', '--', *args, input=input)


def namespace():
    child = subprocess.Popen(['unshare', '--net', '--', 'sleep', '120'])
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('Cannot create private test network namespace')
        if os.stat(f'/proc/{child.pid}/ns/net').st_ino != os.stat('/proc/self/ns/net').st_ino:
            return child
        time.sleep(0.01)
    child.terminate()
    child.wait(timeout=3)
    raise RuntimeError('Test namespace startup timed out')


def link(left_pid, left_name, left_ip, right_pid, right_name, right_ip):
    run('ip', 'link', 'add', 'nat-left', 'type', 'veth', 'peer', 'name', 'nat-right')
    for temporary, pid, name, address in [('nat-left', left_pid, left_name, left_ip),
                                           ('nat-right', right_pid, right_name, right_ip)]:
        if pid != os.getpid():
            run('ip', 'link', 'set', temporary, 'netns', str(pid))
        inside(pid, 'ip', 'link', 'set', temporary, 'name', name)
        inside(pid, 'ip', 'addr', 'add', address, 'dev', name)
        inside(pid, 'ip', 'link', 'set', name, 'up')


if len(run('ip', '-o', 'link', 'show').stdout.splitlines()) != 1:
    raise RuntimeError('Expected an empty test network with only loopback')
run('ip', 'link', 'set', 'lo', 'up')
# These globally shaped addresses exist only in this isolated topology. There is
# no default route or interface connecting the test to the host or the Internet.
run('ip', 'addr', 'add', '13.0.0.1/32', 'dev', 'lo')
run('sysctl', '-qw', 'net.ipv4.ip_forward=1')
for mode in ['browser', 'go', 'blocked']:
    children = []
    capture = None
    try:
        for _ in range(4):
            children.append(namespace())
        gateway_a, client_a, gateway_b, client_b = [p.pid for p in children]
        for pid in [gateway_a, client_a, gateway_b, client_b]:
            inside(pid, 'ip', 'link', 'set', 'lo', 'up')
        for letter, gateway, client, lan, public, port in [
                ('a', gateway_a, client_a, 1, 11, 45000),
                ('b', gateway_b, client_b, 2, 12, 45100)]:
            link(os.getpid(), f'wan-{letter}', f'{public}.0.0.1/24', gateway, 'wan', f'{public}.0.0.2/24')
            network = f'100.64.{lan}' if mode == 'go' else f'10.0.{lan}'
            link(gateway, 'lan', f'{network}.1/24', client, 'eth0', f'{network}.2/24')
            inside(gateway, 'ip', 'route', 'add', 'default', 'via', f'{public}.0.0.1')
            inside(client, 'ip', 'route', 'add', 'default', 'via', f'{network}.1')
            inside(gateway, 'sysctl', '-qw', 'net.ipv4.ip_forward=1')
            outgoing = 'iifname "lan" accept' if mode != 'blocked' else 'iifname "lan" ip daddr 13.0.0.1 accept'
            # Drop unsolicited WAN input before conntrack confirms it as a
            # gateway-local flow occupying the fixed external port.
            inside(gateway, 'nft', '-f', '/dev/stdin', input=f'''table ip nat {{
 chain post {{ type nat hook postrouting priority 100; oifname "wan" meta l4proto udp snat to {public}.0.0.2:{port}; }}
}}
table inet filter {{
 chain input {{ type filter hook input priority 0; policy drop; ct state established,related accept; iifname "lo" accept; }}
 chain forward {{ type filter hook forward priority 0; policy drop;
 ct state established,related accept; {outgoing}; }}
}}
''')
        if os.environ.get('NAT_TEST_DEBUG') == '1':
            capture = subprocess.Popen(['nsenter', '-t', str(client_b), '-n', '--', 'tcpdump', '-ni', 'any', '-c', '120', '-l', 'udp and not port 53 and not port 5353'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        test_env = dict(os.environ, NAT_TEST_SERVER_ADDRESS='100.64.1.2' if mode == 'go' else '10.0.1.2', CHROME_PATH=sys.argv[4])
        result = subprocess.run([sys.argv[1], 'test/rtc-nat-coordinator.mjs', mode,
                                 str(client_a), str(client_b), sys.argv[2]],
                                timeout=60, check=True, env=test_env)
    finally:
        if capture:
            capture.terminate()
            packets, _ = capture.communicate(timeout=5)
            sys.stderr.write(packets[:32768])
        for child in children:
            child.terminate()
        for child in children:
            child.wait(timeout=5)
