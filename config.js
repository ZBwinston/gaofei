// 云端配置
// 1. 在 https://supabase.com 免费新建一个项目（区域建议 Singapore）
// 2. 打开 Project Settings → API，复制 Project URL 和 anon public key
// 3. 填到下面两行，提交到仓库后重新部署
//
// anon key 是「公开密钥」，放在网页里是安全的：数据由数据库的行级权限（RLS）保护，
// 别人拿到这个 key 也只能登录自己的账号、读自己的记录。
// 如果暂时不想配置，也可以在 App 的「我的 → 云端配置」里填，只存在本机。

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
