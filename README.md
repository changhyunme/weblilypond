# WebLily

코드와 빠른 입력 도구를 함께 사용하는 웹 기반 LilyPond 악보 편집기 MVP입니다. 전체 악보에서 파트를 추출하고, 각 악보를 미리 보거나 PDF로 내려받을 수 있습니다.

## Stack

- React 19
- React Router 7 (declarative mode)
- Vite 8
- Cloudflare Vite plugin / OpenAI Sites

Next.js와 Vinext는 사용하지 않습니다.

## Run

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run dev
```

기본 편집기 주소는 `http://localhost:5173/editor`입니다.

## MVP features

- LilyPond 코드 편집과 줄 번호
- 음표, 쉼표, 화음, 셈여림, 반복 등 빠른 삽입
- 입력 후 자동 SVG 미리보기와 수동 컴파일
- 전체 악보의 `Staff` 정의에서 개별 파트보 생성
- 전체 악보 및 각 파트의 PDF 다운로드
- `.ly` 소스 다운로드
- 브라우저 로컬 저장

현재 조판은 Hacklily의 공개 WebSocket 렌더러를 사용합니다. 프로덕션 서비스에서는 안정성, 사용량 제어, 버전 고정을 위해 자체 LilyPond 렌더러를 운영하는 구성을 권장합니다.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm test
```

## References

- [LilyPond](https://lilypond.org/)
- [Hacklily](https://www.hacklily.org/)
- [React Router](https://reactrouter.com/)
