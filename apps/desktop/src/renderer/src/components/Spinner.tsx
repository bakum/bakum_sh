import { IconLoader2 } from '@tabler/icons-react';
import classes from './Spinner.module.css';

/** Rotating loader icon for badges (a Tabler icon is static by itself). */
export function Spinner({ size = 12 }: { size?: number }) {
  return <IconLoader2 size={size} className={classes.spin} />;
}
