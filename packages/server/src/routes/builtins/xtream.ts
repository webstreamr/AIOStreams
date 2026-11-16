import { XtreamAddon } from '@aiostreams/core';
import { liveTvRouter } from './livetv.js';

export default liveTvRouter((config) => new XtreamAddon(config));
