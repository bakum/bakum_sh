import { translator, type Entry } from '@bm/shared';
import common from './messages/common';
import services from './messages/services';
import resources from './messages/resources';
import builds from './messages/builds';
import cli from './messages/cli';
import pipeline from './messages/pipeline';

/** Core's messages in the interface language (D69): errors, notifications, job logs, the bm command. */
export const coreMessages = {
  ...common,
  ...services,
  ...resources,
  ...builds,
  ...cli,
  ...pipeline,
} satisfies Record<string, Entry>;

export type CoreKey = keyof typeof coreMessages;
export const t = translator(coreMessages);
