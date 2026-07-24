import { FastifyPluginAsync } from 'fastify';
import {
  exportFeedRules,
  importFeedRules,
  validateFeedRulesBundle,
} from '../services/feedRulesImportExport';

async function requireUserId(req: any, res: any): Promise<number | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send({ error: 'Authentication required' });
    return null;
  }
  try {
    const decoded: any = await req.jwtVerify();
    const userId = decoded?.userId;
    if (userId == null) {
      res.status(401).send({ error: 'Invalid token' });
      return null;
    }
    return Number(userId);
  } catch {
    res.status(401).send({ error: 'Invalid or expired token' });
    return null;
  }
}

function parseBoolQuery(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const s = String(value ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function formatExportFilename(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `feedgen-rules-${y}${m}${d}.json`;
}

const feedRulesRoutes: FastifyPluginAsync = async (fastify) => {
  /** 导出当前用户私有 Feed 规则包 */
  fastify.get('/export', async (req: any, res: any) => {
    try {
      const userId = await requireUserId(req, res);
      if (userId == null) return;

      const q = (req.query || {}) as {
        include_secrets?: string;
        feed_ids?: string;
        source_types?: string;
      };

      const includeSecrets = parseBoolQuery(q.include_secrets);
      let feedIds: number[] | undefined;
      if (q.feed_ids != null && String(q.feed_ids).trim()) {
        feedIds = String(q.feed_ids)
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (feedIds.length === 0) feedIds = undefined;
      }

      let sourceTypes: Array<'native' | 'parsed'> | undefined;
      if (q.source_types != null && String(q.source_types).trim()) {
        sourceTypes = String(q.source_types)
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is 'native' | 'parsed' => s === 'native' || s === 'parsed');
        if (sourceTypes.length === 0) sourceTypes = undefined;
      }

      const bundle = await exportFeedRules({
        userId,
        includeSecrets,
        ...(feedIds ? { feedIds } : {}),
        ...(sourceTypes ? { sourceTypes } : {}),
      });

      const filename = formatExportFilename();
      res.header('Content-Type', 'application/json; charset=utf-8');
      res.header('Content-Disposition', `attachment; filename="${filename}"`);
      return bundle;
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '导出规则失败' });
    }
  });

  /** 导入规则包：同指纹覆盖，新指纹创建；默认不触发首爬 */
  fastify.post('/import', async (req: any, res: any) => {
    try {
      const userId = await requireUserId(req, res);
      if (userId == null) return;

      const body = (req.body || {}) as Record<string, unknown>;
      // 允许 { bundle, include_secrets } 或直接传规则包
      let bundleRaw: unknown = body;
      let includeSecrets = false;

      if (body && typeof body === 'object' && body.bundle && typeof body.bundle === 'object') {
        bundleRaw = body.bundle;
        includeSecrets = parseBoolQuery(body.include_secrets);
      } else if (body && typeof body === 'object' && body.format === 'feedgen-rules') {
        includeSecrets = parseBoolQuery(
          (req.query as { include_secrets?: string } | undefined)?.include_secrets ??
            body.include_secrets_on_import
        );
      }

      const validated = validateFeedRulesBundle(bundleRaw);
      if (!validated.ok) {
        return res.status(400).send({ error: validated.error });
      }

      const report = await importFeedRules({
        userId,
        bundle: validated.bundle,
        includeSecrets,
      });

      return report;
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: '导入规则失败' });
    }
  });
};

export { feedRulesRoutes };
