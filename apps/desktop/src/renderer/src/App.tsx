import { useEffect, useState } from 'react';
import { Alert, MantineProvider, Stack, Text, Title } from '@mantine/core';

export function App() {
  const [ping, setPing] = useState<string>('…');
  const [banner, setBanner] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      window.bm
        .call('system.ping', {})
        .then((r) => setPing(`Core pid ${r.pid}, запущен ${r.startedAt}`))
        .catch((e: Error) => setPing(`ошибка: ${e.message}`));
    void load();
    return window.bm.onCoreStatus((s) => {
      if (s.state === 'restarted') setBanner(`Core был перезапущен в ${new Date(s.at).toLocaleTimeString()}`);
      if (s.state === 'connected') void load();
    });
  }, []);
  return (
    <MantineProvider defaultColorScheme="auto">
      <Stack p="lg">
        {banner && <Alert color="orange">{banner}</Alert>}
        <Title order={2}>DEMZ Branch Manager</Title>
        <Text>{ping}</Text>
      </Stack>
    </MantineProvider>
  );
}
