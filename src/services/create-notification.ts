import { publishMainStream } from './stream';
import pushSw from './push-notification';
import { Notifications, Mutings, UserProfiles } from '../models';
import { genId } from '../misc/gen-id';
import { User } from '../models/entities/user';
import { Notification } from '../models/entities/notification';

export async function createNotification(
	notifieeId: User['id'],
	type: Notification['type'],
	data: Partial<Notification>
) {
	if (data.notifierId && (notifieeId === data.notifierId)) {
		return null;
	}

	// Create notification
	const notification = await Notifications.save({
		id: genId(),
		createdAt: new Date(),
		notifieeId: notifieeId,
		type: type,
		isRead: false,
		...data
	} as Partial<Notification>);

	const profile = await UserProfiles.findOne({ userId: notifieeId });

	if (!profile?.includingNotificationTypes?.includes(type)) {
		// この通知を見ないようにしているのであれば既読だけして終わる
		await Notifications.update({ id: notification.id }, { isRead: true });
		return notification;
	}

	const packed = await Notifications.pack(notification);

	// Publish notification event
	publishMainStream(notifieeId, 'notification', packed);

	// 2秒経っても(今回作成した)通知が既読にならなかったら「未読の通知がありますよ」イベントを発行する
	setTimeout(async () => {
		const fresh = await Notifications.findOne(notification.id);
		if (fresh == null) return; // 既に削除されているかもしれない
		if (!fresh.isRead) {
			//#region ただしミュートしているユーザーからの通知なら無視
			const mutings = await Mutings.find({
				muterId: notifieeId
			});
			if (data.notifierId && mutings.map(m => m.muteeId).includes(data.notifierId)) {
				return;
			}
			//#endregion

			publishMainStream(notifieeId, 'unreadNotification', packed);

			pushSw(notifieeId, 'notification', packed);
		}
	}, 2000);

	return notification;
}
