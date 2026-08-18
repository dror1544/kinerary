FROM python:3.12-alpine
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY control_plane_worker ./control_plane_worker
USER nobody
CMD ["python", "-m", "control_plane_worker", "run"]
