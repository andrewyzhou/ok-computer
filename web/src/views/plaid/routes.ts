import { defineRoutes } from '../../routes';

// the bank of track s3: the linked banks, their accounts and their recurring charges, with connect, reconnect, sync
// now and disconnect. the subscriptions of the bank show on #/inbox/subscriptions, merged with the receipts.
export default defineRoutes([{ path: 'bank', group: 'connections', label: 'Bank', icon: 'cost', order: 15, load: () => import('./BankPage').then((m) => m.BankPage) }]);
