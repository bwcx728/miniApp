const MIN_NODE_VERSION = [22, 5, 0];

function parseVersion(raw) {
  const [major = '0', minor = '0', patch = '0'] = String(raw || '0.0.0').split('.');
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

function compareVersion(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] || 0;
    const right = b[index] || 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }
  return 0;
}

function formatVersion(parts) {
  return parts.join('.');
}

function printNodeVersionError(currentVersion) {
  console.error(
    [
      `当前 Node.js 版本为 ${currentVersion}。`,
      '此项目的后端依赖内置模块 `node:sqlite`，你的版本还不支持它。',
      `请升级到 Node.js >= ${formatVersion(MIN_NODE_VERSION)}（推荐使用 Node 22 LTS 或更高版本），然后重新执行 \`npm run dev:server\`。`,
      '如果你在 Windows 上使用 nvm-windows，可先执行：',
      '  nvm install 22.22.1',
      '  nvm use 22.22.1'
    ].join('\n')
  );
}

async function main() {
  const currentVersion = process.versions.node;
  if (compareVersion(parseVersion(currentVersion), MIN_NODE_VERSION) < 0) {
    printNodeVersionError(currentVersion);
    process.exit(1);
    return;
  }

  try {
    const { runSelfTest, startServer } = await import('./server.mjs');
    if (process.argv.includes('--self-test')) {
      await runSelfTest();
      return;
    }
    startServer();
  } catch (error) {
    if (error && error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      printNodeVersionError(currentVersion);
      process.exit(1);
      return;
    }
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

main();
