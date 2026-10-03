// Local lexical affinity only: spelling similarity never establishes a person's identity.
export const normalizeSearchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
export const searchWords = value => (normalizeSearchText(String(value || '').slice(0,100000)).match(/[\p{L}\p{N}_@]+/gu) || []).slice(0, 50000);
const transliteration = { а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ж:'zh', з:'z', и:'i', й:'i', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ы:'i', э:'e', ю:'iu', я:'ia', ь:'', ъ:'' };
function phonetic(value) {
  return normalizeSearchText(value).split(/[^\p{L}\p{N}]+/u).map(word => [...word].map(character => transliteration[character] ?? character).join('')
    .replace(/ph/g, 'f').replace(/c(?=[ei])/g, 's').replace(/c/g, 'k').replace(/w/g, 'v').replace(/y/g, 'i')
    .replace(/e$/g, '').replace(/(.)\1/g, '$1')).join('');
}
const nameFamilies = [
  ['саша','саш','саня','сан','санек','саньк','саньком','санек','санька'],
  ['миша','миш','мишка','мишк','миха','мих'],
  ['петя','пет','петька','петьк'],
];
const family = word => nameFamilies.findIndex(group => group.includes(word));
function oneEdit(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let first = 0;
  while (first < Math.min(left.length, right.length) && left[first] === right[first]) first++;
  if (first === Math.min(left.length, right.length)) return true;
  if (left.length === right.length) return left.slice(first + 1) === right.slice(first + 1)
    || (left[first] === right[first + 1] && left[first + 1] === right[first] && left.slice(first + 2) === right.slice(first + 2));
  const longer = left.length > right.length ? left : right, shorter = left.length > right.length ? right : left;
  return longer.slice(first + 1) === shorter.slice(first);
}
export function lexicalMatch(needle, value, stem) {
  const token = normalizeSearchText(needle), tokens = searchWords(value);
  if (!token) return null;
  if (normalizeSearchText(value).trim() === token || tokens.includes(token)) return { code:'exact', weight:100 };
  const numbers=token.match(/\d+/gu)||[],valueNumbers=new Set(normalizeSearchText(value).match(/\d+/gu)||[]);
  if(numbers.some(number=>!valueNumbers.has(number)))return null;
  const sameNumbers=candidate=>{
    if(!numbers.length)return true;
    const candidateNumbers=String(candidate).match(/\d+/gu)||[];
    return candidateNumbers.length===numbers.length && candidateNumbers.every((number,index)=>number===numbers[index]);
  };
  if (token.startsWith('@')) return null;
  const root = stem(token);
  if (tokens.some(word => sameNumbers(word) && stem(word) === root)) return { code:'form', weight:80 };
  const sound = phonetic(token);
  // Compounds may be written with spaces or punctuation in either alphabet.
  const compact = tokens.slice(0, 64).map(phonetic).join('');
  if (sound.length >= 4 && (tokens.some(word => sameNumbers(word) && phonetic(word) === sound) || sameNumbers(value) && compact === sound)) return { code:'translit', weight:60 };
  if (sound.length >= 6 && sound.length <= 64 && (sameNumbers(value) && oneEdit(sound,compact) || tokens.slice(0,200).some(word => sameNumbers(word) && oneEdit(sound,phonetic(word))))) return { code:'phonetic', weight:45 };
  const parts = searchWords(token);
  const inflectedSound = parts.map(part => phonetic(stem(part))).join('');
  const inflectedEnding = parts.map((part,index) => phonetic(index===parts.length-1 ? stem(part) : part)).join('');
  const compactForms = tokens.slice(0,64).map(word => phonetic(stem(word))).join('');
  if (parts.length > 1 && inflectedEnding.length >= 4 && (sameNumbers(value) && inflectedEnding === compact || tokens.some(word => sameNumbers(word) && phonetic(word) === inflectedEnding))) return { code:'form',weight:70 };
  if ((parts.length > 1 || tokens.length > 1) && inflectedSound.length >= 4 && (sameNumbers(value) && inflectedSound === compactForms || tokens.some(word => sameNumbers(word) && phonetic(stem(word)) === inflectedSound))) return { code:'form',weight:70 };
  if (parts.length > 1 && inflectedSound.length >= 6 && inflectedSound.length <= 64 && sameNumbers(value) && oneEdit(inflectedSound,compactForms)) return { code:'phonetic',weight:45 };
  if (parts.length > 1) {
    const matches = parts.slice(0,12).map(part => lexicalMatch(part,value,stem));
    if (matches.every(Boolean)) return matches.reduce((weakest,hit)=>hit.weight<weakest.weight ? hit : weakest);
  }
  const name = family(root);
  if (name >= 0 && tokens.some(word => sameNumbers(word) && family(stem(word)) === name)) return { code:'name-family', weight:30 };
  if (token.length >= 5 && token.length <= 64 && !token.startsWith('@') && tokens.slice(0, 200).some(word => sameNumbers(word) && word.length >= 5 && word.length <= 64 && oneEdit(token, word))) return { code:'typo', weight:40 };
  return null;
}
