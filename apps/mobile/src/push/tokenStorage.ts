import * as SecureStore from "expo-secure-store";
const KEY = "yishu.pushToken";
export const readPushToken = () => SecureStore.getItemAsync(KEY);
export const savePushToken = (token: string) => SecureStore.setItemAsync(KEY, token);
export const clearPushToken = () => SecureStore.deleteItemAsync(KEY);
