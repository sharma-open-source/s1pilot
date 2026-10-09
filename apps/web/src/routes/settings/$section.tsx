import { createFileRoute } from '@tanstack/react-router';

import { SettingsPage } from '@/features/settings/SettingsPage';

export const Route = createFileRoute('/settings/$section')({
  component: function SettingsRoute() {
    const { section } = Route.useParams();
    return <SettingsPage section={section} />;
  },
});
