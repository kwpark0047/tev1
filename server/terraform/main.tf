terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.10"
    }
    cert-manager = {
      source  = "jetstack/cert-manager"
      version = "~> 1.13"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}

provider "helm" {
  kubernetes {
    config_path = "~/.kube/config"
  }
}

provider "cert-manager" {
  cert_manager_version = "1.13.0"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-2"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "tev1-cluster"
}

variable "domain_name" {
  description = "Domain name for TLS"
  type        = string
  default     = "ws.tev1.example.com"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version  = "~> 5.0"

  name = "${var.cluster_name}-vpc"
  cidr_block = var.vpc_cidr

  azs             = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = false
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.cluster_name}-vpc"
    Environment = "production"
  }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version  = "~> 19.0"

  cluster_name    = var.cluster_name
  cluster_version = "1.28"

  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_private_access = true
  cluster_endpoint_public_access  = true

  eks_managed_node_group_defaults = {
    ami_type       = "AL2_x86_64"
    instance_types = ["t3.medium"]
  }

  eks_managed_node_groups = {
    general = {
      name           = "general"
      instance_types = ["t3.medium"]
      capacity_type  = "ON_DEMAND"
      min_size       = 3
      max_size       = 10
      desired_size   = 3
    }
    spot = {
      name           = "spot"
      instance_types = ["t3.medium", "t3a.medium"]
      capacity_type  = "SPOT"
      min_size       = 0
      max_size       = 5
      desired_size   = 0
    }
  }

  tags = {
    Environment = "production"
    Project     = "tev1"
  }
}

resource "kubernetes_namespace" "tev1" {
  metadata {
    name = "tev1"
    labels = {
      name        = "tev1"
      environment = "production"
    }
  }
}

resource "kubernetes_config_map" "tev1_ws_config" {
  metadata {
    name      = "tev1-ws-config"
    namespace = "tev1"
  }
  data = {
    PORT               = "8081"
    NODE_ENV           = "production"
    LOG_LEVEL          = "info"
    WS_HEARTBEAT_INTERVAL = "30000"
    WS_MAX_RECONNECT_ATTEMPTS = "5"
    CORS_ORIGINS       = "https://tev1.example.com,https://tev1-admin.example.com"
  }
}

resource "kubernetes_secret" "tev1_ws_secrets" {
  metadata {
    name      = "tev1-ws-secrets"
    namespace = "tev1"
  }
  string_data = {
    JWT_SECRET      = var.jwt_secret
    REDIS_PASSWORD  = var.redis_password
  }
}

resource "kubernetes_deployment" "tev1_ws" {
  metadata {
    name      = "tev1-ws"
    namespace = "tev1"
    labels = {
      app        = "tev1-ws"
      version    = "v1"
      managed-by = "terraform"
    }
  }
  spec {
    replicas = 3
    selector {
      match_labels = {
        app = "tev1-ws"
      }
    }
    template {
      metadata {
        labels = {
          app        = "tev1-ws"
          version    = "v1"
          managed-by = "terraform"
        }
        annotations = {
          "prometheus.io/scrape" = "true"
          "prometheus.io/port"   = "8081"
          "prometheus.io/path"   = "/metrics"
        }
      }
      spec {
        service_account_name = "tev1-ws-sa"
        security_context {
          run_as_non_root = true
          run_as_user     = 1001
          fs_group        = 1001
        }
        container {
          name  = "tev1-ws"
          image = "ghcr.io/your-org/tev1-ws:latest"
          image_pull_policy = "Always"
          port {
            container_port = 8081
            name           = "ws"
          }
          port {
            container_port = 8082
            name           = "metrics"
          }
          env_from {
            config_map_ref {
              name = "tev1-ws-config"
            }
          }
          env_from {
            secret_ref {
              name = "tev1-ws-secrets"
            }
          }
          resources {
            requests = {
              cpu    = "500m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "1000m"
              memory = "512Mi"
            }
          }
          liveness_probe {
            http_get {
              path = "/health"
              port = 8081
            }
            initial_delay_seconds = 15
            period_seconds       = 10
          }
          readiness_probe {
            http_get {
              path = "/health"
              port = 8081
            }
            initial_delay_seconds = 5
            period_seconds       = 5
          }
          volume_mount {
            name       = "tmp-volume"
            mount_path = "/tmp"
          }
        }
        volume {
          name = "tmp-volume"
          empty_dir = {}
        }
      }
    }
  }
}

resource "kubernetes_service" "tev1_ws" {
  metadata {
    name      = "tev1-ws"
    namespace = "tev1"
    annotations = {
      "service.beta.kubernetes.io/aws-load-balancer-type" = "nlb"
      "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled" = "true"
    }
  }
  spec {
    type     = "LoadBalancer"
    selector = { app = "tev1-ws" }
    port {
      name       = "ws"
      port       = 8081
      target_port = 8081
      protocol   = "TCP"
    }
    port {
      name       = "metrics"
      port       = 8082
      target_port = 8082
      protocol   = "TCP"
    }
    session_affinity = "ClientIP"
  }
}

resource "kubernetes_ingress" "tev1_ws" {
  metadata {
    name      = "tev1-ws-ingress"
    namespace = "tev1"
    annotations = {
      "kubernetes.io/ingress.class"                       = "nginx"
      "nginx.ingress.kubernetes.io/ssl-redirect"          = "true"
      "nginx.ingress.kubernetes.io/websocket-services"    = "tev1-ws"
      "nginx.ingress.kubernetes.io/proxy-read-timeout"    = "3600"
      "nginx.ingress.kubernetes.io/proxy-send-timeout"    = "3600"
      "nginx.ingress.kubernetes.io/proxy-buffering"       = "off"
      "nginx.ingress.kubernetes.io/proxy-http-version"    = "1.1"
      "cert-manager.io/cluster-issuer"                    = "letsencrypt-prod"
    }
  }
  spec {
    tls {
      hosts      = ["ws.tev1.example.com", "api.tev1.example.com"]
      secret_name = "tev1-tls-secret"
    }
    rule {
      host = "ws.tev1.example.com"
      http {
        path {
          path     = "/"
          path_type = "Prefix"
          backend {
            service_name = "tev1-ws"
            service_port = 8081
          }
        }
      }
    }
    rule {
      host = "api.tev1.example.com"
      http {
        path {
          path     = "/api"
          path_type = "Prefix"
          backend {
            service_name = "tev1-ws"
            service_port = 8081
          }
        }
        path {
          path     = "/health"
          path_type = "Prefix"
          backend {
            service_name = "tev1-ws"
            service_port = 8081
          }
        }
      }
    }
  }
}

resource "certmanager_certificate" "tev1_tls" {
  metadata {
    name      = "tev1-tls-secret"
    namespace = "tev1"
  }
  spec {
    secret_name = "tev1-tls-secret"
    issuer_ref {
      name  = "letsencrypt-prod"
      kind  = "ClusterIssuer"
    }
    dns_names = ["ws.tev1.example.com", "api.tev1.example.com"]
    duration  = "2160h"
    renew_before = "360h"
  }
}

resource "certmanager_cluster_issuer" "letsencrypt_prod" {
  metadata {
    name = "letsencrypt-prod"
  }
  spec {
    acme {
      server = "https://acme-v02.api.letsencrypt.org/directory"
      email  = "admin@tev1.example.com"
      private_key_secret_ref {
        name = "letsencrypt-prod-key"
      }
      solver {
        http01 {
          ingress {
            class = "nginx"
          }
        }
      }
    }
  }
}

resource "kubernetes_service_account" "tev1_ws_sa" {
  metadata {
    name      = "tev1-ws-sa"
    namespace = "tev1"
  }
}

resource "kubernetes_role" "tev1_ws_role" {
  metadata {
    name      = "tev1-ws-role"
    namespace = "tev1"
  }
  rule {
    api_groups = [""]
    resources  = ["pods", "services", "endpoints", "configmaps", "secrets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch"]
  }
  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "replicasets"]
    verbs      = ["get", "list", "watch"]
  }
}

resource "kubernetes_role_binding" "tev1_ws_rolebinding" {
  metadata {
    name      = "tev1-ws-rolebinding"
    namespace = "tev1"
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = "tev1-ws-role"
  }
  subject {
    kind      = "ServiceAccount"
    name      = "tev1-ws-sa"
    namespace = "tev1"
  }
}

resource "kubernetes_horizontal_pod_autoscaler" "tev1_ws_hpa" {
  metadata {
    name      = "tev1-ws-hpa"
    namespace = "tev1"
  }
  spec {
    scale_target_ref {
      api_version = "apps/v1"
      kind        = "Deployment"
      name        = "tev1-ws"
    }
    min_replicas = 3
    max_replicas = 20
    metric {
      resource {
        name = "cpu"
        target {
          type               = "Utilization"
          average_utilization = 70
        }
      }
    }
    metric {
      resource {
        name = "memory"
        target {
          type               = "Utilization"
          average_utilization = 80
        }
      }
    }
    behavior {
      scale_down {
        stabilization_window_seconds = 300
        policy {
          type          = "Percent"
          value         = 10
          period_seconds = 60
        }
      }
      scale_up {
        stabilization_window_seconds = 0
        policy {
          type          = "Percent"
          value         = 100
          period_seconds = 15
        }
      }
    }
  }
}