/** Sensitive action classes the guards can detect. */
export type SensitiveClass = 'pay' | 'delete' | 'send' | 'submit-order' | 'account-change';

/**
 * Keyword lists per class, per language. Matching is case-insensitive on word boundaries.
 * Classes are checked in the order listed (priority). Add a language by adding a key to a list.
 */
export const SENSITIVE_KEYWORDS: ReadonlyArray<readonly [SensitiveClass, Readonly<Record<string, readonly string[]>>]> = [
  [
    'delete',
    {
      en: ['delete', 'remove account', 'close account', 'erase', 'destroy', 'deactivate'],
      de: ['löschen'],
      fr: ['supprimer'],
      es: ['eliminar', 'borrar'],
    },
  ],
  [
    'pay',
    {
      en: ['pay', 'pay now', 'place order', 'purchase', 'buy now', 'make payment', 'submit payment'],
      de: ['bezahlen', 'jetzt kaufen'],
      fr: ['payer', 'acheter', 'passer la commande'],
      es: ['pagar', 'comprar', 'realizar pedido'],
    },
  ],
  [
    'submit-order',
    {
      en: ['submit order', 'confirm order', 'complete order', 'finalize order', 'complete purchase'],
      de: ['bestellung abschließen'],
      fr: ['valider la commande'],
      es: ['confirmar pedido'],
    },
  ],
  [
    'send',
    {
      en: ['send', 'send message', 'publish', 'post', 'share', 'invite'],
      de: ['senden', 'absenden'],
      fr: ['envoyer'],
      es: ['enviar'],
    },
  ],
  [
    'account-change',
    {
      en: ['change password', 'change email', 'update email', 'update password', 'reset password', 'change username'],
      de: ['passwort ändern'],
      fr: ['changer le mot de passe'],
      es: ['cambiar contraseña'],
    },
  ],
];
