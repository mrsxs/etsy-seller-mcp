// 买家隐私：接口返回里去掉买家的姓名、地址、邮箱、留言、礼物附言和个性化内容，只留收货国家。
// 适用于所有返回（组合工具、通用调用、写操作预检的「改前」快照）。

/** 订单（receipt）里的买家个人信息字段 */
const RECEIPT_PII = ['buyer_email', 'name', 'first_line', 'second_line', 'city', 'state', 'zip', 'formatted_address', 'payment_email',
  'message_from_buyer', 'message_from_payment', 'gift_message', 'gift_sender'];
/** 用户资料（非本店店主时） */
const USER_PII = ['primary_email', 'first_name', 'last_name', 'image_url_75x75'];

const HIDDEN = '[已隐藏]';

const isReceipt = (o) => 'receipt_id' in o && ('buyer_user_id' in o || 'buyer_email' in o || 'formatted_address' in o);
const isUser = (o) => 'user_id' in o && ('primary_email' in o || 'first_name' in o || 'last_name' in o);
const isTransactionVariation = (o) => 'formatted_name' in o && 'formatted_value' in o;
/** 买家填写的个性化内容：property_id 54 是个性化（卖家可以自定义问题名，不能只看名字）；新版个性化问题带 question_id */
const PERSONALIZATION_PROPERTY = 54;
const isPersonalization = (o) => Number(o.property_id) === PERSONALIZATION_PROPERTY
  || (o.question_id !== undefined && o.question_id !== null)
  || /personali|個性|个性/i.test(String(o.formatted_name));

/**
 * 深拷贝并脱敏。ownUserId：本店店主的 Etsy 用户 ID（店主自己的资料不隐藏）。
 * 返回 { data, hidden }：hidden 是被隐藏的字段名（去重），用于在结果里说明。
 */
export function redact(value, { ownUserId = null } = {}) {
  const hidden = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    if (isReceipt(v)) {
      for (const k of RECEIPT_PII) {
        if (out[k] !== undefined && out[k] !== null && out[k] !== '') {
          out[k] = HIDDEN;
          hidden.add(k);
        }
      }
    }
    if (isUser(v) && (ownUserId === null || Number(v.user_id) !== Number(ownUserId))) {
      for (const k of USER_PII) {
        if (out[k] !== undefined && out[k] !== null && out[k] !== '') {
          out[k] = HIDDEN;
          hidden.add(k);
        }
      }
    }
    // 订单商品里买家填的个性化内容（可能是名字、日期、上传文件地址等）
    if (isTransactionVariation(v) && isPersonalization(v)) {
      out.formatted_value = HIDDEN;
      hidden.add('personalization');
    }
    return out;
  };
  return { data: walk(value), hidden: [...hidden] };
}

export const PRIVACY_NOTE = '买家姓名、地址、邮箱、留言、礼物附言、个性化内容已隐藏（只保留收货国家）。';
