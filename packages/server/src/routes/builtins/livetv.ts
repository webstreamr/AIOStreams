import { Router, Request, Response, NextFunction } from 'express';
import { fromUrlSafeBase64 } from '@aiostreams/core';
import type { Manifest, Meta, MetaPreview, Stream } from '@aiostreams/core';
import { rawExtras } from '../../utils/extras.js';

interface LiveTvAddon {
  getManifest(): Promise<Manifest>;
  getCatalog(
    type: string,
    id: string,
    extras?: string
  ): Promise<{ metas: MetaPreview[] } | { metasDetailed: Meta[] }>;
  getMeta(type: string, id: string): Promise<Meta>;
  getStreams(type: string, id: string): Promise<Stream[]>;
}

interface Params {
  encodedConfig: string;
  type: string;
  id: string;
}

/**
 * The routes of a live TV builtin, its config JSON in base64 before them;
 * `failure` maps an error before it is answered.
 */
export function liveTvRouter(
  create: (config: unknown) => LiveTvAddon,
  failure: (error: unknown) => unknown = (error) => error
) {
  const router: Router = Router();
  const addonOf = (encodedConfig: string) =>
    create(JSON.parse(fromUrlSafeBase64(encodedConfig)));

  router.get(
    '/:encodedConfig/manifest.json',
    async (
      req: Request<Pick<Params, 'encodedConfig'>>,
      res: Response,
      next: NextFunction
    ) => {
      try {
        res.json(await addonOf(req.params.encodedConfig).getManifest());
      } catch (error) {
        next(failure(error));
      }
    }
  );

  router.get(
    '/:encodedConfig/catalog/:type/:id{/:extras}.json',
    async (
      req: Request<Params & { extras?: string }>,
      res: Response,
      next: NextFunction
    ) => {
      const { encodedConfig, type, id } = req.params;
      try {
        res.json(
          await addonOf(encodedConfig).getCatalog(type, id, rawExtras(req))
        );
      } catch (error) {
        next(failure(error));
      }
    }
  );

  router.get(
    '/:encodedConfig/meta/:type/:id.json',
    async (req: Request<Params>, res: Response, next: NextFunction) => {
      const { encodedConfig, type, id } = req.params;
      try {
        res.json({ meta: await addonOf(encodedConfig).getMeta(type, id) });
      } catch (error) {
        next(failure(error));
      }
    }
  );

  router.get(
    '/:encodedConfig/stream/:type/:id.json',
    async (req: Request<Params>, res: Response, next: NextFunction) => {
      const { encodedConfig, type, id } = req.params;
      try {
        res.json({
          streams: await addonOf(encodedConfig).getStreams(type, id),
        });
      } catch (error) {
        next(failure(error));
      }
    }
  );

  return router;
}
