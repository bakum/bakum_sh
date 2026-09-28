import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { MethodName, MethodParams, MethodResult } from '@bm/shared';
import { call, errorText } from './bm';

export function useBm<K extends MethodName>(
  method: K,
  params: MethodParams<K>,
  opts: Partial<UseQueryOptions<MethodResult<K>, Error>> = {},
) {
  return useQuery<MethodResult<K>, Error>({
    queryKey: [method, params],
    queryFn: () => call(method, params),
    ...opts,
  });
}

/** Mutation with a Russian error toast by default. */
export function useBmMutation<K extends MethodName>(method: K, opts: { success?: string; silentError?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation<MethodResult<K>, Error, MethodParams<K>>({
    mutationFn: (p) => call(method, p),
    onSuccess: () => {
      if (opts.success) notifications.show({ color: 'green', message: opts.success });
      void qc.invalidateQueries();
    },
    onError: (e) => {
      if (!opts.silentError) notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e), autoClose: 12000 });
    },
  });
}
