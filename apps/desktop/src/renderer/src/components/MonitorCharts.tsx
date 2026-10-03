import { useState } from 'react';
import { Box, Paper, Text, useComputedColorScheme } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { t } from '../i18n';
import { fmtTime } from '../lib/format';

/**
 * Small single-series charts of the Monitor tab (dataviz rules): one hue validated for both themes, 2px line with a
 * 10% area wash, 4px rounded column caps with 2px gaps, hairline grid, crosshair / per-column tooltips. The title
 * names the series, so there is no legend; the values are also in the table view below the charts.
 */

// Validated with the dataviz palette script: light #1c7ed6 on the light surface, dark #339af0 on the dark one.
const SERIES = { light: '#1c7ed6', dark: '#339af0' };
const PAD = { top: 12, right: 56, bottom: 22, left: 44 };
const HEIGHT = 150;

export interface Point {
  t: number;
  v: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const hhmm = (at: number) => fmtTime(at, false);

function useChrome() {
  const scheme = useComputedColorScheme('light');
  return {
    series: SERIES[scheme],
    grid: 'var(--mantine-color-default-border)',
    surface: 'var(--mantine-color-body)',
    muted: 'var(--mantine-color-dimmed)',
  };
}

function Axes({ w, h, yMax, format, from, to }: { w: number; h: number; yMax: number; format: (v: number) => string; from: number; to: number }) {
  const c = useChrome();
  const ticks = [0, yMax / 2, yMax];
  const xTicks: number[] = [];
  const step = 15 * 60_000;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) xTicks.push(t);
  const x = (t: number) => PAD.left + ((t - from) / (to - from)) * (w - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / yMax) * (h - PAD.top - PAD.bottom);
  return (
    <g fontSize={10} fill={c.muted} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} stroke={c.grid} strokeWidth={1} />
          <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end">
            {format(v)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={t} x={x(t)} y={h - 6} textAnchor="middle">
          {hhmm(t)}
        </text>
      ))}
    </g>
  );
}

function Tip({ x, y, value, label }: { x: number; y: number; value: string; label: string }) {
  return (
    <Paper shadow="sm" withBorder px={8} py={4} style={{ position: 'absolute', left: x + 10, top: Math.max(0, y - 34), pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      <Text size="sm" fw={600}>
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Paper>
  );
}

/** A line over the last hour; `yCap` fixes the top of the scale (e.g. the memory limit). */
export function TimeLineChart({ title, points, format, from, to, yCap }: { title: string; points: Point[]; format: (v: number) => string; from: number; to: number; yCap?: number }) {
  const { ref, width } = useElementSize();
  const c = useChrome();
  const [hover, setHover] = useState<Point | null>(null);
  const w = Math.max(width, 200);
  const yMax = yCap ?? niceMax(Math.max(...points.map((p) => p.v), 0) * 1.1);
  const x = (t: number) => PAD.left + ((t - from) / (to - from)) * (w - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - Math.min(v, yMax) / yMax) * (HEIGHT - PAD.top - PAD.bottom);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = points.length ? `${line}L${x(points[points.length - 1]!.t).toFixed(1)},${y(0)}L${x(points[0]!.t).toFixed(1)},${y(0)}Z` : '';
  const last = points[points.length - 1];
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - r.left) / r.width) * (to - from);
    let best: Point | null = null;
    for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best);
  };
  return (
    <Box>
      <Text size="sm" fw={600} mb={4}>
        {title}
      </Text>
      <Box ref={ref} pos="relative">
        {!points.length ? (
          <Text size="sm" c="dimmed" h={HEIGHT} pt="xl" ta="center">
            {t('chart.noData')}
          </Text>
        ) : (
          <svg width={w} height={HEIGHT} role="img" aria-label={title}>
            <Axes w={w} h={HEIGHT} yMax={yMax} format={format} from={from} to={to} />
            <path d={area} fill={c.series} fillOpacity={0.1} />
            <path d={line} fill="none" stroke={c.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {last && (
              <>
                <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={c.series} stroke={c.surface} strokeWidth={2} />
                <text x={x(last.t) + 8} y={y(last.v) + 4} fontSize={11} fill="var(--mantine-color-text)" fontWeight={600}>
                  {format(last.v)}
                </text>
              </>
            )}
            {hover && (
              <>
                <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke={c.muted} strokeWidth={1} />
                <circle cx={x(hover.t)} cy={y(hover.v)} r={4} fill={c.series} stroke={c.surface} strokeWidth={2} />
              </>
            )}
            <rect x={PAD.left} y={0} width={w - PAD.left - PAD.right} height={HEIGHT} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
        {hover && <Tip x={x(hover.t)} y={y(hover.v)} value={format(hover.v)} label={hhmm(hover.t)} />}
      </Box>
    </Box>
  );
}

/** Columns per minute over the last hour (requests); the tooltip also shows response times and errors. */
export function MinuteBars({
  title,
  bars,
  from,
  to,
  detail,
}: {
  title: string;
  bars: { t: number; v: number }[];
  from: number;
  to: number;
  detail: (t: number) => string;
}) {
  const { ref, width } = useElementSize();
  const c = useChrome();
  const [hover, setHover] = useState<{ t: number; v: number } | null>(null);
  const w = Math.max(width, 200);
  const yMax = niceMax(Math.max(...bars.map((b) => b.v), 0));
  const plotW = w - PAD.left - PAD.right;
  const slot = plotW / 60;
  const barW = Math.min(24, Math.max(2, slot - 2));
  const x = (t: number) => PAD.left + ((t - from) / (to - from)) * plotW;
  const y = (v: number) => PAD.top + (1 - v / yMax) * (HEIGHT - PAD.top - PAD.bottom);
  const base = y(0);
  const col = (bx: number, top: number) => {
    const r = Math.min(4, barW / 2, base - top);
    return `M${bx},${base}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${base}Z`;
  };
  return (
    <Box>
      <Text size="sm" fw={600} mb={4}>
        {title}
      </Text>
      <Box ref={ref} pos="relative">
        {!bars.length ? (
          <Text size="sm" c="dimmed" h={HEIGHT} pt="xl" ta="center">
            {t('chart.noRequests')}
          </Text>
        ) : (
          <svg width={w} height={HEIGHT} role="img" aria-label={title}>
            <Axes w={w} h={HEIGHT} yMax={yMax} format={(v) => String(Math.round(v))} from={from} to={to} />
            {bars.map((b) => {
              const bx = x(b.t) + (slot - barW) / 2;
              return (
                <g key={b.t} onPointerEnter={() => setHover(b)} onPointerLeave={() => setHover(null)}>
                  <rect x={x(b.t)} y={PAD.top} width={slot} height={base - PAD.top} fill="transparent" />
                  <path d={col(bx, y(b.v))} fill={c.series} fillOpacity={hover && hover.t !== b.t ? 0.6 : 1} />
                </g>
              );
            })}
          </svg>
        )}
        {hover && <Tip x={x(hover.t)} y={y(hover.v)} value={t('chart.requests', { n: hover.v })} label={detail(hover.t)} />}
      </Box>
    </Box>
  );
}
