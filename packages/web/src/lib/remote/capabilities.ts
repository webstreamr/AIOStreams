import { browserFeatures, type PlayerFeature } from '../playback/controller';

/**
 * What this device takes from another's remote. A player that cannot list a
 * file's audio tracks cannot switch them either, so it does not offer that and
 * the remote leaves the picker out rather than showing one that does nothing.
 */
export function remoteCapabilities(
  features: readonly PlayerFeature[] = browserFeatures
) {
  return {
    PlayableMediaTypes: ['Video'],
    SupportedCommands: [
      'DisplayContent',
      ...(features.includes('audio') ? ['SetAudioStreamIndex'] : []),
      'SetSubtitleStreamIndex',
    ],
    SupportsMediaControl: true,
  };
}
