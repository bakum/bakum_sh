import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Code, CopyButton, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { t } from '../i18n';

interface Props {
  children: ReactNode;
  /** Where the boundary sits: a page keeps the shell usable, the root replaces the whole window. */
  scope: 'page' | 'root';
  /** A change (e.g. the route) clears a caught error without remounting healthy children. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Catches render errors so a bug in one page shows its message instead of unmounting the whole window.
 * The page boundary gets the route as resetKey in Shell, so navigating elsewhere clears the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, stack: '' });
  }

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const details = `${error.stack ?? `${error.name}: ${error.message}`}\n\n${t('boundary.components')}${stack}`;
    return (
      <Stack p="md" maw={960} data-testid="error-boundary">
        <Alert color="red" variant="light" title={t(this.props.scope === 'page' ? 'boundary.page' : 'boundary.window')}>
          <Stack gap="xs">
            <Text size="sm">
              {error.message || error.name}
            </Text>
            <Text size="sm" c="dimmed">
              {t('boundary.notJobs')} {t(this.props.scope === 'page' ? 'boundary.tryPage' : 'boundary.tryWindow')} {t('boundary.issue')}
            </Text>
            <Group gap="xs">
              {this.props.scope === 'page' && (
                <Button size="xs" variant="default" onClick={() => this.setState({ error: null, stack: '' })}>
                  {t('boundary.retry')}
                </Button>
              )}
              <Button size="xs" variant="default" onClick={() => window.location.reload()}>
                {t('boundary.reload')}
              </Button>
              <CopyButton value={details}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="subtle" onClick={copy}>
                    {copied ? t('common.copied') : t('boundary.copyDetails')}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        </Alert>
        <ScrollArea.Autosize mah={360}>
          <Code block fz="xs">
            {details}
          </Code>
        </ScrollArea.Autosize>
      </Stack>
    );
  }
}
