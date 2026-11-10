# -*- coding: utf-8 -*-
"""
서울교통공사_서울 도시철도 열차운행시각표(CSV) → 당일 분실 화면용 시간표 JSON

  원본: 공공데이터포털 15098251 (https://www.data.go.kr/data/15098251/fileData.do, 로그인 없이 다운로드, 이용허락범위 제한 없음)
  사용: python make_timetable.py 서울교통공사_서울도시철도열차운행시각표_YYYYMMDD.csv [출력폴더]
  결과: {호선}_{DAY|SAT|END}.json + index.json  (토요일 시간표가 휴일과 같으면 휴일 파일을 같이 씀)

  파일 형식
    st = 역 이름 목록, tr = [열차코드, 방향(UP/DOWN/IN/OUT), 급행(1/0), 도착역, [역번호, 시각, 역번호, 시각, ...]]
    시각 = 0시부터 분×10 (예: 11:10:30 → 6705). 영업일 기준이라 24시·25시는 1440분 이상
    도착시간이 있으면 도착시간, 없으면 출발시간. '00:00:00'은 빈 값으로 봄
"""
import csv, json, math, os, sys

SRC_DEFAULT = '서울교통공사_서울 도시철도 열차운행시각표 (공공데이터포털 15098251, 이용허락범위 제한 없음)'
# 실시간 열차(updnLine 0/1)와 같은 방향의 시간표 방향. 2026-11-10 실시간 열차 400대와 시간표를 대조해 정함
UPDN = {'1': [['UP'], ['DOWN']], '2': [['OUT', 'UP'], ['IN', 'DOWN']], '3': [['UP'], ['DOWN']], '4': [['UP'], ['DOWN']],
        '5': [['UP'], ['DOWN']], '6': [['UP'], ['DOWN']], '7': [['UP'], ['DOWN']], '8': [['UP'], ['DOWN']], '9': [['DOWN'], ['UP']]}
# 실시간 열차번호 숫자와 시간표 열차코드 숫자가 같은 노선 (2호선 본선은 번호 체계가 달라 시각으로만 맞춤)
CODE_MATCH = {'1': 1, '2': 0, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1}


def tmin10(arr, dep):
    v = arr if arr and arr != '00:00:00' else (dep if dep and dep != '00:00:00' else '')
    if not v:
        return None
    h, m, s = (v.split(':') + ['0'])[:3]
    return math.floor((int(h) * 60 + int(m) + int(s or 0) / 60) * 10 + 0.5)  # 화면(JavaScript Math.round)과 같은 반올림


def read_rows(path):
    for enc in ('cp949', 'utf-8-sig'):
        try:
            with open(path, encoding=enc, newline='') as f:
                rows = list(csv.reader(f))
            return rows[1:]
        except UnicodeDecodeError:
            continue
    raise SystemExit('CSV 글자 인코딩을 읽지 못했어요: ' + path)


def build(rows, src=SRC_DEFAULT):
    files = {}
    for c in rows:
        if len(c) < 12:
            continue
        line, st_name, day, way, exp, code, arr, dep, to = c[1], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[11]
        f = files.setdefault(line + '_' + day, {'st': [], 'ix': {}, 'tr': {}})
        if st_name not in f['ix']:
            f['ix'][st_name] = len(f['st'])
            f['st'].append(st_name)
        t = tmin10(arr, dep)
        if t is None:
            continue
        key = (code, way, c[10], to)
        tr = f['tr'].setdefault(key, {'c': code, 'd': way, 'e': int(exp or 0), 'to': to, 's': []})
        tr['s'].append((f['ix'][st_name], t))
    out = {}
    for k, f in files.items():
        trs = []
        for tr in f['tr'].values():
            s = sorted(tr['s'], key=lambda x: x[1])
            trs.append([tr['c'], tr['d'], tr['e'], tr['to'], [v for p in s for v in p]])
        trs.sort(key=lambda r: (r[4][1], r[0]))
        line, day = k.split('_')
        out[k] = {'line': line, 'day': day, 'src': src, 't': '0시 기준 분×10 (24시 넘으면 1440 이상)', 'st': f['st'], 'tr': trs}
    index = {'src': src, 'fmt': 'tr = [열차코드, 방향, 급행(1), 도착역, [역번호, 시각, 역번호, 시각, ...]] · 시각 = 분×10',
             'files': {}, 'updn': dict(UPDN, note='실시간 열차(updnLine 0/1)와 같은 방향의 시간표 방향'),
             'codeMatch': dict(CODE_MATCH, note='실시간 열차번호와 시간표 열차코드의 숫자가 같은 노선')}
    keep = {}
    for line in sorted({k.split('_')[0] for k in out}, key=int):
        index['files'][line] = {}
        for day in ('DAY', 'SAT', 'END'):
            k = line + '_' + day
            if k not in out:
                continue
            e = out.get(line + '_END')
            if day == 'SAT' and e and out[k]['tr'] == e['tr'] and out[k]['st'] == e['st']:
                k = line + '_END'
            index['files'][line][day] = k + '.json'
            keep[k] = out[k]
    return keep, index


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src_csv = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
    name = os.path.splitext(os.path.basename(src_csv))[0]
    keep, index = build(read_rows(src_csv), SRC_DEFAULT.replace('열차운행시각표', '열차운행시각표_' + name.split('_')[-1]) if name[-8:].isdigit() else SRC_DEFAULT)
    for k, v in keep.items():
        with open(os.path.join(dst, k + '.json'), 'w', encoding='utf-8') as f:
            json.dump(v, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(dst, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print('시간표 파일', len(keep), '개를 만들었어요 →', dst)


if __name__ == '__main__':
    main()
