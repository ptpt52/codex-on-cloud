import { parseArgs } from 'node:util';
import { publicationClient } from './cloudflare-client.mjs';

const { values } = parseArgs({ options: {
  domain: { type: 'string' }, zone: { type: 'string' }, 'api-token-file': { type: 'string' }, rename: { type: 'boolean' },
  'prepare-only': { type: 'boolean' }, 'commit-only': { type: 'boolean' }, rollback: { type: 'boolean' },
} });
try {
  const domain = values.domain?.toLowerCase(), zone = values.zone?.toLowerCase();
  if (!domain || !zone || !domain.endsWith('.' + zone) || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9.-]+$/.test(zone) || !values['api-token-file'] || ['prepare-only', 'commit-only', 'rollback'].filter(key => values[key]).length > 1) throw Error('需要 --domain、--zone、--api-token-file；发布阶段选项不能同时使用');
  if (process.getuid() === 0) throw Error('请以普通用户运行');
  const publication = await publicationClient(values);
  if (values.rollback) { await publication.rollback({ domain, zone }); console.log('公网发布回退检查完成；原任务保留。'); }
  else {
    if (!values['commit-only']) await publication.prepare({ domain, zone, rename: values.rename });
    if (values['prepare-only']) console.log('公网配置已准备，远端路由和DNS未切换。加载本机服务并验证就绪后执行 --commit-only。');
    else { await publication.commit({ domain, zone }); console.log(`公网入口已验证并提交：https://${domain}`); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
