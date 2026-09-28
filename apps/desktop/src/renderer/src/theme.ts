import { createTheme, type MantineColorsTuple } from '@mantine/core';

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
