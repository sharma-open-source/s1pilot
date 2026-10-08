import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/p/$key/analytics/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/p/$key/analytics/$view', params: { key: params.key, view: 'quality' } });
  },
});
