import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Code, CopyButton, Group, ScrollArea, Stack, Text } from '@mantine/core';

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
    const details = `${error.stack ?? `${error.name}: ${error.message}`}\n\nКомпоненты:${stack}`;
    return (
      <Stack p="md" maw={960} data-testid="error-boundary">
        <Alert color="red" variant="light" title={this.props.scope === 'page' ? 'Страница завершилась с ошибкой' : 'Окно завершилось с ошибкой'}>
          <Stack gap="xs">
            <Text size="sm">
              {error.message || error.name}
            </Text>
            <Text size="sm" c="dimmed">
              Это ошибка приложения, задачи и сборки она не затрагивает.{' '}
              {this.props.scope === 'page'
                ? 'Попробуйте ещё раз, откройте другой раздел или перезагрузите окно.'
                : 'Перезагрузите окно.'}{' '}
              Если повторяется — скопируйте подробности в issue.
            </Text>
            <Group gap="xs">
              {this.props.scope === 'page' && (
                <Button size="xs" variant="default" onClick={() => this.setState({ error: null, stack: '' })}>
                  Попробовать ещё раз
                </Button>
              )}
              <Button size="xs" variant="default" onClick={() => window.location.reload()}>
                Перезагрузить окно
              </Button>
              <CopyButton value={details}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="subtle" onClick={copy}>
                    {copied ? 'Скопировано' : 'Скопировать подробности'}
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
