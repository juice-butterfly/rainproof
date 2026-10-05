"""实测喂价脚本要用的天气 API 在本机网络下能否直连。
候选：Open-Meteo（免费、免 key）、和风天气、OpenWeatherMap。
"""
import json
import ssl
import urllib.request
import urllib.error

OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),                      # 绕开本机环境代理
    urllib.request.HTTPSHandler(context=ssl.create_default_context())
)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def probe(name, url, note=""):
    req = urllib.request.Request(url, headers=UA)
    try:
        with OPENER.open(req, timeout=20) as r:
            body = r.read()
            print(f"\n[OK  {r.status}] {name}")
            if note:
                print("      ", note)
            text = body.decode("utf-8", "replace")
            try:
                j = json.loads(text)
                print("      ", json.dumps(j, ensure_ascii=False)[:600])
            except Exception:
                print("      ", text[:300])
            return True
    except urllib.error.HTTPError as e:
        print(f"\n[HTTP {e.code}] {name}")
        print("      ", e.read()[:200])
    except Exception as e:
        print(f"\n[FAIL] {name}: {type(e).__name__}: {e}")
    return False


print("=" * 78)
print("① Open-Meteo（免费、免 API key，主力候选）")
print("=" * 78)
probe("Open-Meteo forecast · 武汉 未来1天逐日降雨",
      "https://api.open-meteo.com/v1/forecast?latitude=30.5928&longitude=114.3055"
      "&daily=precipitation_sum&timezone=Asia%2FShanghai&forecast_days=2",
      "只要 daily.precipitation_sum 这个数组 —— 单位 mm")

probe("Open-Meteo archive · 武汉 指定日期区间累计降雨",
      "https://archive-api.open-meteo.com/v1/archive?latitude=30.5928&longitude=114.3055"
      "&start_date=2026-09-28&end_date=2026-10-04&daily=precipitation_sum&timezone=Asia%2FShanghai",
      "★ 这是「自固定起点累计」的实现方式（单调递增，适合合约里的增量口径）")

print()
print("=" * 78)
print("② 备用数据源（需要 key，先确认域名通不通）")
print("=" * 78)
probe("和风天气 devapi", "https://devapi.qweather.com/v7/weather/now?location=101200101&key=test")
probe("OpenWeatherMap", "https://api.openweathermap.org/data/2.5/weather?q=Wuhan&appid=test")
