import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/p/$key/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/p/$key/cases', params: { key: params.key } });
  },
});
