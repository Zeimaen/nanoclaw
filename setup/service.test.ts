import { describe, it, expect } from 'vitest';
import path from 'path';

import { getLaunchdLabel } from '../src/install-slug.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(nodePath: string, projectRoot: string, homeDir: string): string {
  const label = getLaunchdLabel(projectRoot);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>${projectRoot}/node_modules/.bin/tsx ${projectRoot}/scripts/matrix-e2ee-rotate-device.ts &amp;&amp; exec ${nodePath} ${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(nodePath: string, projectRoot: string, homeDir: string, isSystem: boolean): string {
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStartPre=${projectRoot}/node_modules/.bin/tsx ${projectRoot}/scripts/matrix-e2ee-rotate-device.ts
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = generatePlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = generatePlist('/opt/node/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('exec /opt/node/bin/node /home/user/nanoclaw/dist/index.js');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });

  it('rotates the Matrix E2EE device id before exec-ing into node', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('matrix-e2ee-rotate-device.ts &amp;&amp; exec /usr/local/bin/node');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', true);
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false);
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js');
  });

  it('rotates the Matrix E2EE device id before every start via ExecStartPre', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false);
    expect(unit).toContain(
      'ExecStartPre=/srv/nanoclaw/node_modules/.bin/tsx /srv/nanoclaw/scripts/matrix-e2ee-rotate-device.ts',
    );
    // Must precede ExecStart so rotation always completes before the host boots.
    expect(unit.indexOf('ExecStartPre=')).toBeLessThan(unit.indexOf('ExecStart='));
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
${JSON.stringify(projectRoot + '/node_modules/.bin/tsx')} ${JSON.stringify(projectRoot + '/scripts/matrix-e2ee-rotate-device.ts')}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });

  it('rotates the Matrix E2EE device id before starting', () => {
    const projectRoot = '/home/user/nanoclaw';
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
${JSON.stringify(projectRoot + '/node_modules/.bin/tsx')} ${JSON.stringify(projectRoot + '/scripts/matrix-e2ee-rotate-device.ts')}
nohup /usr/bin/node ${JSON.stringify(projectRoot)}/dist/index.js &`;

    const rotateIdx = wrapper.indexOf('matrix-e2ee-rotate-device.ts');
    const nohupIdx = wrapper.indexOf('nohup');
    expect(rotateIdx).toBeGreaterThan(-1);
    expect(rotateIdx).toBeLessThan(nohupIdx);
  });
});
