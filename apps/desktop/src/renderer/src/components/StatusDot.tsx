import { Box, Loader, Tooltip } from '@mantine/core';
import type { LiveIndicator } from '@bm/shared';
import { t } from '../i18n';


const COLOR: Record<LiveIndicator, string> = {
  ok: '#2fb344',
  warning: '#f59f00',
  failed: '#e03131',
  stopped: '#adb5bd',
  none: 'transparent',
  building: '',
  unknown: 'transparent',
};

/** Live build indicator (spec 6): green / orange / red / grey / empty / dashed (Docker down) / spinner. */
export function StatusDot({ indicator, size = 10 }: { indicator: LiveIndicator; size?: number }) {
  return (
    <Tooltip label={t(`dot.${indicator}`)} openDelay={400}>
      {indicator === 'building' ? (
        <Loader size={size + 2} color="orange" data-indicator={indicator} />
      ) : (
        <Box
          data-indicator={indicator}
          style={{
            width: size,
            height: size,
            flex: `0 0 ${size}px`,
            borderRadius: '50%',
            background: COLOR[indicator],
            border: indicator === 'none' ? '1.5px solid var(--mantine-color-gray-5)' : indicator === 'unknown' ? '1.5px dashed var(--mantine-color-gray-5)' : 'none',
          }}
        />
      )}
    </Tooltip>
  );
}
