<?php
/* ============================================================
   SKU Work Tracker — PHP Backend (JSON file storage, no MySQL needed)
   อัปโหลดไฟล์นี้ร่วมกับ sku-tracker.html และ sku-import.csv ขึ้น hosting PHP (PHP 7.4+)
   ระบบจะ Auto-detect และใช้โหมดทีม (ข้อมูลซิงค์กันจริง) อัตโนมัติ

   - บันทึกแบบรวมการเปลี่ยนแปลง (merge) : หลายคนทำงานพร้อมกันได้ ข้อมูลไม่ทับกัน
   - รหัสผ่านเก็บเป็น password_hash() ฝั่ง server เท่านั้น ไม่ส่งไปที่เบราว์เซอร์
   - เฉพาะ Admin แก้ไขผู้ใช้ / ร้านค้าได้
   - ไฟล์ข้อมูลตั้งชื่อแบบสุ่ม + ป้องกันการเปิดโดยตรง
   ============================================================ */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
if (PHP_VERSION_ID >= 70300) {
  session_set_cookie_params(['lifetime'=>0, 'path'=>'/', 'httponly'=>true, 'samesite'=>'Lax', 'secure'=>$secure]);
}
session_start();

$dataDir = __DIR__ . '/data';
$csvFile = __DIR__ . '/sku-import.csv';
$COLLECTIONS = ['users','shops','products','worklogs','tiktoks','history','tiktok_jobs','sales','import_audits','tasks','campaigns','albums'];
$LIMITS = ['history'=>3000, 'import_audits'=>1000];

$DEFAULT_SHOPS = [
  ['Shopee','DP'],['Shopee','KS'],['Shopee','ALP'],['Shopee','BS'],['Shopee','AM'],['Shopee','PK'],['Shopee','PS'],['Shopee','A2'],
  ['Lazada','PR'],['Lazada','ZN'],['Lazada','PT'],['Lazada','WS'],['Lazada','TP'],['Lazada','PP'],
  ['TikTok','SP'],['TikTok','TJ'],['TikTok','PROSPERSPORT'],['TikTok','PM']
];

function respond($arr, $code = 200){ http_response_code($code); echo json_encode($arr, JSON_UNESCAPED_UNICODE); exit; }
function newId(){ return base_convert((string)round(microtime(true)*1000), 10, 36) . bin2hex(random_bytes(3)); }

/* ---------- data file (random name, protected folder) ---------- */
function dataFilePath(){
  global $dataDir;
  if (!is_dir($dataDir) && !@mkdir($dataDir, 0775, true)) respond(['ok'=>false,'error'=>'cannot create data dir (chmod 775 โฟลเดอร์ให้ PHP เขียนได้)'], 500);
  if (!file_exists($dataDir.'/.htaccess')) @file_put_contents($dataDir.'/.htaccess', "Require all denied\nDeny from all\n");
  if (!file_exists($dataDir.'/index.html')) @file_put_contents($dataDir.'/index.html', '');
  $cfg = $dataDir . '/_dbname.php';
  if (!file_exists($cfg)) {
    $name = 'db-' . bin2hex(random_bytes(12)) . '.json';
    // ย้ายข้อมูลจากเวอร์ชันเก่า (data/db.json) ถ้ามี
    if (file_exists($dataDir.'/db.json')) @rename($dataDir.'/db.json', $dataDir.'/'.$name);
    if (@file_put_contents($cfg, "<?php return '" . $name . "';\n") === false) respond(['ok'=>false,'error'=>'cannot write data dir'], 500);
  }
  $name = include $cfg;
  return $dataDir . '/' . $name;
}

function seedDb(){
  global $csvFile, $DEFAULT_SHOPS;
  $shops = []; $i = 1;
  foreach ($DEFAULT_SHOPS as $s) { $shops[] = ['id'=>'s'.$i, 'platform'=>$s[0], 'code'=>$s[1], 'name'=>$s[1], 'active'=>true]; $i++; }
  $now = date('c');
  $users = [
    ['id'=>'u1','name'=>'Admin','username'=>'admin','pass'=>password_hash('admin123', PASSWORD_DEFAULT),'role'=>'Admin','active'=>true,'shop_ids'=>array_column($shops,'id'),'created_at'=>$now],
    ['id'=>'u2','name'=>'A','username'=>'userA','pass'=>password_hash('user123', PASSWORD_DEFAULT),'role'=>'User','active'=>true,'shop_ids'=>['s1','s2','s3','s4','s5','s6','s7','s8'],'created_at'=>$now],
    ['id'=>'u3','name'=>'B','username'=>'userB','pass'=>password_hash('user123', PASSWORD_DEFAULT),'role'=>'User','active'=>true,'shop_ids'=>['s9','s10','s11','s12','s13','s14','s15','s16'],'created_at'=>$now],
    ['id'=>'u4','name'=>'C','username'=>'userC','pass'=>password_hash('user123', PASSWORD_DEFAULT),'role'=>'User','active'=>true,'shop_ids'=>['s17','s18','s1','s9','s15'],'created_at'=>$now],
  ];
  $products = []; $seen = [];
  if (file_exists($csvFile) && ($fp = fopen($csvFile, 'r'))) {
    fgetcsv($fp); $i = 1;
    while (($row = fgetcsv($fp)) !== false) {
      $sku = trim(preg_replace('/^\xEF\xBB\xBF/', '', (string)($row[0] ?? '')));
      if ($sku === '' || isset($seen[strtoupper($sku)])) continue;
      $seen[strtoupper($sku)] = true;
      $products[] = ['id'=>'p'.$i, 'sku'=>$sku, 'name'=>trim((string)($row[2] ?? '')), 'brand'=>trim((string)($row[1] ?? '')), 'created_at'=>$now, 'active'=>true];
      $i++;
    }
    fclose($fp);
  }
  return ['users'=>$users, 'shops'=>$shops, 'products'=>$products, 'worklogs'=>[], 'tiktoks'=>[], 'history'=>[], 'tiktok_jobs'=>[], 'sales'=>[], 'import_audits'=>[], 'tasks'=>[], 'campaigns'=>[], 'meta'=>new stdClass()];
}

function migrateDb(&$db){
  global $COLLECTIONS;
  foreach ($COLLECTIONS as $c) { if (!isset($db[$c]) || !is_array($db[$c])) $db[$c] = []; $db[$c] = array_values($db[$c]); }
  if (!isset($db['meta']) || !is_array($db['meta'])) $db['meta'] = [];
  foreach ($db['sales'] as &$s) { if (empty($s['id'])) $s['id'] = newId(); } unset($s);
  foreach ($db['history'] as &$h) { if (empty($h['id'])) $h['id'] = newId(); } unset($h);
  normalizeUserShopIds($db);
}

function normalizeUserShopIds(&$db){
  $all = [];
  foreach ($db['shops'] as $s) { if (!empty($s['id'])) $all[] = $s['id']; }
  foreach ($db['users'] as &$u) {
    if (!isset($u['shop_ids']) || !is_array($u['shop_ids'])) $u['shop_ids'] = [];
    if (($u['role'] ?? 'User') === 'Admin') { $u['shop_ids'] = $all; }
    else { $u['shop_ids'] = array_values(array_unique(array_filter($u['shop_ids'], function($id) use ($all){ return in_array($id, $all, true); }))); }
  }
  unset($u);
}

/* Run $fn(&$db) with the data file locked. $write=true saves the result. */
function withDb(callable $fn, $write = false){
  $path = dataFilePath();
  $fp = fopen($path, 'c+');
  if (!$fp) respond(['ok'=>false,'error'=>'cannot open data file'], 500);
  flock($fp, $write ? LOCK_EX : LOCK_SH);
  $raw = stream_get_contents($fp);
  $db = $raw ? json_decode($raw, true) : null;
  $seeded = false;
  if (!is_array($db)) {
    if (!$write) { flock($fp, LOCK_UN); fclose($fp); return withDb($fn, true); } // need exclusive lock to seed
    $db = seedDb(); $seeded = true;
  }
  migrateDb($db);
  $result = $fn($db);
  if ($write || $seeded) {
    $json = json_encode($db, JSON_UNESCAPED_UNICODE);
    if ($json === false) { flock($fp, LOCK_UN); fclose($fp); respond(['ok'=>false,'error'=>'encode failed'], 500); }
    ftruncate($fp, 0); rewind($fp); fwrite($fp, $json); fflush($fp);
  }
  flock($fp, LOCK_UN); fclose($fp);
  return $result;
}

function stripUser($u){ unset($u['pass'], $u['new_password']); return $u; }
function publicDb($db){ $db['users'] = array_map('stripUser', $db['users']); if (empty($db['meta'])) $db['meta'] = new stdClass(); return $db; }
function findIndex($list, $id){ foreach ($list as $i => $it) { if (($it['id'] ?? null) === $id) return $i; } return -1; }
function sessionUser(){ return $_SESSION['user'] ?? null; }
function requireLogin(){ if (empty($_SESSION['user'])) respond(['ok'=>false,'error'=>'unauthorized'], 401); }
function readJson(){ $in = json_decode(file_get_contents('php://input'), true); return is_array($in) ? $in : []; }
function refreshSessionUser($db){
  $su = sessionUser(); if (!$su) return null;
  foreach ($db['users'] as $u) {
    if ($u['id'] === $su['id']) {
      if (empty($u['active'])) { $_SESSION = []; return null; }
      $_SESSION['user'] = stripUser($u); return $_SESSION['user'];
    }
  }
  $_SESSION = []; return null;
}

$action = $_GET['a'] ?? '';

/* เปิด api.php?a=health เพื่อตรวจว่า hosting พร้อมใช้งาน (ไม่แสดงข้อมูลลับ) */
if ($action === 'health') {
  $checks = ['php_version'=>PHP_VERSION, 'php_ok'=>PHP_VERSION_ID >= 70400, 'json'=>function_exists('json_encode'), 'sessions'=>session_status() === PHP_SESSION_ACTIVE];
  $dir = $dataDir;
  if (!is_dir($dir)) @mkdir($dir, 0775, true);
  $checks['data_folder_writable'] = is_dir($dir) && is_writable($dir);
  if ($checks['data_folder_writable']) dataFilePath(); // creates the protection files
  $checks['data_folder_protected'] = file_exists($dir.'/.htaccess');
  $checks['sku_csv_found'] = file_exists($csvFile);
  $checks['ready'] = $checks['php_ok'] && $checks['json'] && $checks['sessions'] && $checks['data_folder_writable'];
  $checks['message'] = $checks['ready'] ? 'พร้อมใช้งาน ✓' : 'ยังไม่พร้อม — ดูค่าที่เป็น false';
  respond($checks);
}

if ($action === 'me') {
  $defaultAdmin = withDb(function($db){
    foreach ($db['users'] as $u) {
      if (($u['role'] ?? '') === 'Admin' && !empty($u['active']) && password_verify('admin123', $u['pass'] ?? '')) return true;
    }
    return false;
  });
  respond(['api'=>true, 'user'=>sessionUser(), 'default_admin'=>$defaultAdmin]);
}

if ($action === 'login') {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') respond(['ok'=>false], 405);
  $in = readJson();
  $username = trim((string)($in['username'] ?? '')); $password = (string)($in['password'] ?? '');
  $user = withDb(function($db) use ($username, $password){
    foreach ($db['users'] as $u) {
      if (!empty($u['active']) && strcasecmp($u['username'], $username) === 0 && password_verify($password, $u['pass'] ?? '')) return stripUser($u);
    }
    return null;
  });
  if (!$user) { usleep(400000); respond(['ok'=>false]); }
  session_regenerate_id(true);
  $_SESSION['user'] = $user;
  respond(['ok'=>true, 'user'=>$user]);
}

if ($action === 'logout') { $_SESSION = []; session_destroy(); respond(['ok'=>true]); }

if ($action === 'bootstrap') {
  requireLogin();
  $out = withDb(function($db){ return ['user'=>refreshSessionUser($db), 'db'=>publicDb($db)]; });
  if (!$out['user']) respond(['ok'=>false,'error'=>'unauthorized'], 401);
  respond(['ok'=>true, 'user'=>$out['user'], 'db'=>$out['db']]);
}

/* Apply a set of changes (upserts / deletes per collection). Merges with what other users saved. */
if ($action === 'sync') {
  requireLogin();
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') respond(['ok'=>false], 405);
  $in = readJson();
  $ops = (isset($in['ops']) && is_array($in['ops'])) ? $in['ops'] : [];
  $meta = (isset($in['meta']) && is_array($in['meta'])) ? $in['meta'] : null;
  $res = withDb(function(&$db) use ($ops, $meta){
    global $COLLECTIONS, $LIMITS;
    $me = refreshSessionUser($db);
    if (!$me) return ['error'=>'unauthorized'];
    $isAdmin = ($me['role'] ?? '') === 'Admin';
    $skipped = [];
    foreach ($ops as $coll => $op) {
      if (!in_array($coll, $COLLECTIONS, true) || !is_array($op)) continue;
      if (($coll === 'users' || $coll === 'shops') && !$isAdmin) { $skipped[] = $coll; continue; }
      $list = $db[$coll];
      foreach ((array)($op['delete'] ?? []) as $id) {
        if ($coll === 'users' && $id === $me['id']) continue; // ห้ามลบตัวเอง
        $i = findIndex($list, $id); if ($i >= 0) array_splice($list, $i, 1);
      }
      foreach ((array)($op['upsert'] ?? []) as $item) {
        if (!is_array($item) || empty($item['id']) || !is_string($item['id'])) continue;
        $i = findIndex($list, $item['id']);
        if ($coll === 'users') {
          $newPw = isset($item['new_password']) ? (string)$item['new_password'] : '';
          unset($item['pass'], $item['new_password']);
          if ($i >= 0) { $item['pass'] = $list[$i]['pass']; }
          elseif ($newPw === '') { continue; } // ผู้ใช้ใหม่ต้องมีรหัสผ่าน
          if ($newPw !== '') $item['pass'] = password_hash($newPw, PASSWORD_DEFAULT);
          if ($item['id'] === $me['id']) { $item['role'] = 'Admin'; $item['active'] = true; } // กันแอดมินลดสิทธิ์ตัวเอง
          foreach ($list as $j => $other) { // username ห้ามซ้ำ
            if ($j !== $i && strcasecmp($other['username'] ?? '', $item['username'] ?? '') === 0) continue 2;
          }
        }
        if ($coll === 'worklogs') { // SKU + Platform + ร้าน มีได้ 1 รายการ — เก็บอันล่าสุด
          foreach ($list as $j => $w) {
            if ($j !== $i && ($w['product_id'] ?? '') === ($item['product_id'] ?? '') && ($w['platform'] ?? '') === ($item['platform'] ?? '') && ($w['shop_id'] ?? '') === ($item['shop_id'] ?? '')) {
              if (strcmp($w['updated_at'] ?? '', $item['updated_at'] ?? '') > 0) continue 2;
              array_splice($list, $j, 1); if ($i > $j) $i--; break;
            }
          }
        }
        if ($i >= 0) $list[$i] = $item; else $list[] = $item;
      }
      if (isset($LIMITS[$coll]) && count($list) > $LIMITS[$coll]) {
        $list = ($coll === 'history') ? array_slice($list, 0, $LIMITS[$coll]) : array_slice($list, -$LIMITS[$coll]);
      }
      $db[$coll] = array_values($list);
    }
    if ($meta !== null) $db['meta'] = array_merge(is_array($db['meta']) ? $db['meta'] : [], $meta);
    normalizeUserShopIds($db);
    refreshSessionUser($db);
    return ['ok'=>true, 'skipped'=>$skipped];
  }, true);
  if (!empty($res['error'])) respond(['ok'=>false,'error'=>$res['error']], 401);
  respond($res);
}

if ($action === 'change_password') {
  requireLogin();
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') respond(['ok'=>false], 405);
  $in = readJson();
  $old = (string)($in['old'] ?? ''); $new = (string)($in['new'] ?? '');
  if (strlen($new) < 4) respond(['ok'=>false,'error'=>'รหัสใหม่ต้องอย่างน้อย 4 ตัวอักษร']);
  $meId = sessionUser()['id'];
  $r = withDb(function(&$db) use ($old, $new, $meId){
    foreach ($db['users'] as &$u) {
      if ($u['id'] === $meId) {
        if (!password_verify($old, $u['pass'] ?? '')) return 'รหัสเก่าไม่ถูกต้อง';
        $u['pass'] = password_hash($new, PASSWORD_DEFAULT); return true;
      }
    }
    return 'ไม่พบผู้ใช้';
  }, true);
  if ($r !== true) respond(['ok'=>false,'error'=>$r]);
  respond(['ok'=>true]);
}

respond(['api'=>true, 'user'=>sessionUser()]);
