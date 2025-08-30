FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy Python requirements
COPY requirements.txt pyproject.toml* ./

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create non-root user
RUN addgroup --system --gid 1001 python
RUN adduser --system --uid 1001 python

# Change ownership and switch to non-root user
RUN chown -R python:python /app
USER python

# Expose port
EXPOSE 3002

# Start the application
CMD ["python", "-m", "src.main"]