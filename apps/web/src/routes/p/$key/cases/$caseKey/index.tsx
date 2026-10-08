import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/p/$key/cases/$caseKey/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/p/$key/cases/$caseKey/$tab', params: { ...params, tab: 'steps' }, replace: true });
  },
});
