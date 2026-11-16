import { M3uAddon } from '@aiostreams/core';
import { liveTvRouter } from './livetv.js';

export default liveTvRouter((config) => new M3uAddon(config));
