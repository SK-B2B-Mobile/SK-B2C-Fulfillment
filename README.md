Apps Script Backend (Google Apps Script)
이 폴더는 SK B2C Fulfillment 웹앱의 백엔드(Google Apps Script) 코드를 GitHub에서
버전관리(백업)하기 위한 폴더입니다.
실제 실행은 Google Apps Script 에디터/배포에서 이루어지며, 이 폴더는 소스 백업 및
변경 이력 관리 용도입니다. GitHub의 내용을 바꿔도 Apps Script가 자동으로 바뀌지는
않습니다 (반대도 마찬가지) — 아래 "동기화 방법"을 참고하세요.
파일 구성
`Code.gs` — 서버 로직 전체 (피킹리스트, 스캔로그, ShipStation/TikTok 연동, Webhook 등)
`appsscript.json` — 프로젝트 설정 (실행 권한, OAuth 스코프, 웹앱 배포 설정)
현재 버전 (백업 시점 기준)
v38 — PREFIX_MAP에 1156 prefix 추가, upsertList_ active 행 보호
이전 주요 변경사항은 `Code.gs` 상단 주석(v25~v38) 참고
동기화 방법 (앞으로 계속 백업하려면)
방법 A — 수동 복사 (가장 간단, 지금 당장 가능)
Apps Script 에디터에서 `Code.gs` 전체 코드를 복사
이 폴더의 `Code.gs`에 붙여넣기 → GitHub에 커밋
`appsscript.json`도 프로젝트 설정(⚙️ 톱니바퀴 → 편집기 설정 → "appsscript.json 매니페스트 파일 표시") 켠 뒤 동일하게 복사
방법 B — `clasp` CLI 사용 (권장, 자동화 가능)
Google이 만든 공식 도구로 Apps Script ↔ 로컬 폴더를 명령어 한 줄로 동기화할 수 있습니다.
```bash
npm install -g @google/clasp
clasp login
cd apps-script
clasp clone <스크립트ID>      # 최초 1회, Apps Script 편집기 URL의 ID
# 이후 수정할 때마다:
clasp pull                    # Apps Script → 로컬로 받아오기
clasp push                    # 로컬 → Apps Script로 올리기
```
스크립트 ID는 Apps Script 에디터 → 프로젝트 설정에서 확인 가능합니다.
`clasp`를 쓰면 코드를 고칠 때마다 GitHub에 커밋 → `clasp push`로 바로 배포까지 가능해서,
지금처럼 에디터에서 직접 고치다 실수로 배포가 꼬이는 문제를 줄일 수 있습니다.
웹앱 배포 정보
배포 방식: `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`
프런트엔드(`index.html`)는 이 Apps Script 웹앱 URL을 API 엔드포인트로 호출합니다.
