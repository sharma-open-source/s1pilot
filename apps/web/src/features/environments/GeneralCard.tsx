import { ALL_SENSITIVE, BROWSER_PRESETS, LOCALE_PRESETS, parseDomains, withCurrent, type EnvForm, type FormErrors } from './model';

import { Card, Checkbox, Field, Input, Select, Tag } from '@/components/ui';

/** General card: base URL, allowed domains (chips), default browser, locale & timezone. */
export function GeneralCard({
  form,
  errors,
  domainText,
  onDomainText,
  onChange,
}: {
  form: EnvForm;
  errors: FormErrors;
  /** Uncommitted text of the allowed-domains input (lifted so Save can include it). */
  domainText: string;
  onDomainText: (text: string) => void;
  onChange: (patch: Partial<EnvForm>) => void;
}) {
  const commit = () => {
    if (domainText.trim() === '') return;
    onChange({ allowDomains: [...new Set([...form.allowDomains, ...parseDomains(domainText)])] });
    onDomainText('');
  };
  return (
    <Card aria-label="General" className="flex flex-col gap-3.5 p-5">
      <h2 className="text-[17px] font-semibold text-fg">General</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <Field label="Base URL" hint={errors.baseUrl !== undefined ? <span role="alert" className="text-danger">{errors.baseUrl}</span> : undefined}>
          {(id) => (
            <Input
              id={id}
              mono
              type="url"
              value={form.baseUrl}
              aria-invalid={errors.baseUrl !== undefined}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Allowed domains"
          hint={
            errors.allowDomains !== undefined ? (
              <span role="alert" className="text-danger">
                {errors.allowDomains}
              </span>
            ) : (
              'Comma separated. Press Enter or leave the field to add.'
            )
          }
        >
          {(id) => (
            <div className="flex flex-col gap-2">
              <Input
                id={id}
                mono
                value={domainText}
                placeholder="staging.shop.example, pay.sandbox.example"
                aria-invalid={errors.allowDomains !== undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  onDomainText(v);
                }}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                  }
                }}
              />
              {form.allowDomains.length > 0 && (
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Allowed domain list">
                  {form.allowDomains.map((d) => (
                    <li key={d}>
                      <Tag mono className="gap-1.5 py-1">
                        {d}
                        <button
                          type="button"
                          aria-label={`Remove ${d}`}
                          className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center border-0 bg-transparent text-secondary"
                          onClick={() => onChange({ allowDomains: form.allowDomains.filter((x) => x !== d) })}
                        >
                          ×
                        </button>
                      </Tag>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Field>
        <Field label="Default browser">
          {(id) => (
            <Select id={id} value={form.browser} onChange={(e) => onChange({ browser: e.target.value })}>
              {withCurrent(BROWSER_PRESETS, form.browser).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Locale & timezone">
          {(id) => (
            <Select id={id} value={form.localeTz} onChange={(e) => onChange({ localeTz: e.target.value })}>
              {withCurrent(LOCALE_PRESETS, form.localeTz).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Card>
  );
}

/** Safeguards card. "Block navigation outside allowed domains" is derived from the allowed-domains list. */
export function SafeguardsCard({ form, onChange }: { form: EnvForm; onChange: (patch: Partial<EnvForm>) => void }) {
  const approvals = ALL_SENSITIVE.every((a) => form.requireApprovalFor.includes(a));
  return (
    <Card aria-label="Safeguards" className="flex flex-col gap-2.5 p-[18px] text-sm">
      <h2 className="text-[15px] font-semibold text-fg">Safeguards</h2>
      <Checkbox label="Read-only (block form submits)" checked={form.readOnly} onChange={(e) => onChange({ readOnly: e.target.checked })} />
      <Checkbox
        label="Approve payments, deletes, sends"
        checked={approvals}
        onChange={(e) => onChange({ requireApprovalFor: e.target.checked ? [...ALL_SENSITIVE] : [] })}
      />
      <Checkbox label="Block navigation outside allowed domains" checked={form.allowDomains.length > 0} disabled aria-describedby="block-nav-hint" />
      <span id="block-nav-hint" className="text-xs text-muted">
        Enforced whenever Allowed domains is not empty.
      </span>
    </Card>
  );
}
