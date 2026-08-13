# ── 빌드 스테이지: 정적 산출물 생성
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── 서빙 스테이지: nginx가 SPA 서빙 + /api 리버스 프록시 (기획서 §4 아키텍처)
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
