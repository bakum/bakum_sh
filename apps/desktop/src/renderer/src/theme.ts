import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

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
export const LIGHT_BG = '#eef0f3';
export const LIGHT_SURFACE = '#f7f8fa';

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': LIGHT_BG,
    '--mantine-color-default': LIGHT_SURFACE,
    '--mantine-color-default-hover': '#e7eaee',
    '--bm-surface': LIGHT_SURFACE,
  },
  dark: { '--bm-surface': 'var(--mantine-color-body)' },
});
