import {
  DEFAULT_THEME,
  createTheme,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core';

// odoo.sh palette: plum header, teal accents.
const plum: MantineColorsTuple = ['#f8eff5', '#ecdbe6', '#d9b3cc', '#c689b1', '#b6669a', '#ac508b', '#a74584', '#923671', '#832f65', '#714b67'];
const teal: MantineColorsTuple = ['#e0fbfa', '#cdf2f0', '#9fe4e1', '#6cd6d0', '#45cac3', '#2dc2bb', '#1bbfb7', '#00a8a0', '#00968f', '#00827c'];

export const theme = createTheme({
  primaryColor: 'teal',
  colors: { plum, teal },
  fontFamily: 'Segoe UI, Roboto, system-ui, sans-serif',
  defaultRadius: 'sm',
  components: {
    Button: { defaultProps: { size: 'xs' } },
    ActionIcon: { defaultProps: { variant: 'subtle' } },
  },
});

export const HEADER_BG = '#714b67';

// Light scheme without pure white (too bright on a large window): the page is light gray, surfaces (cards, papers,
// dropdowns, inputs, sidebar) a notch lighter. Pure-white surfaces are switched over in theme.css.
export const LIGHT_BG = '#e7e9ed';
export const LIGHT_SURFACE = '#f7f8fa';

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': LIGHT_BG,
    '--mantine-color-default': LIGHT_SURFACE,
    '--mantine-color-default-hover': '#eceef1',
    '--bm-surface': LIGHT_SURFACE,
  },
  dark: { '--bm-surface': 'var(--mantine-color-body)' },
});

// odoo.sh slate (D68): in the light scheme the branch sidebar and the branch header with its tabs stay dark, the
// content stays light. Elements with the `bm-chrome` class get Mantine's dark-scheme variables, re-pointed to these
// colors; the rules that depend on the class are in theme.css.
export const CHROME = {
  bg: '#32373f',
  raised: '#3a404a',
  hover: '#444b57',
  input: '#22262c',
  border: '#4b525e',
  text: '#e9ecef',
  dimmed: '#a3a9b4',
};

/** CSS for `.bm-chrome` in the light scheme: the dark-scheme variables (light/outline variants of every color, text,
 *  borders) plus the slate surfaces. Rendered once as a <style> next to MantineProvider. */
export function chromeCss(): string {
  const dark = defaultCssVariablesResolver(mergeMantineTheme(DEFAULT_THEME, theme)).dark;
  const vars: Record<string, string> = {
    ...dark,
    '--mantine-color-body': CHROME.bg,
    '--mantine-color-text': CHROME.text,
    '--mantine-color-dimmed': CHROME.dimmed,
    '--mantine-color-placeholder': CHROME.dimmed,
    '--mantine-color-default': CHROME.raised,
    '--mantine-color-default-hover': CHROME.hover,
    '--mantine-color-default-color': '#ffffff',
    '--mantine-color-default-border': CHROME.border,
    '--bm-surface': CHROME.input,
    '--bm-chrome-raised': CHROME.raised,
    '--bm-row-bg': CHROME.raised,
  };
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `:root[data-mantine-color-scheme='light'] .bm-chrome {\n${body}\n}\n`;
}
