disable_mlock = true

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

storage "postgresql" {
  table = "openbao_kv_store"
}

seal "static" {
  current_key_id = "tangow-1"
  current_key    = "file:///run/secrets/unseal.key"
}

audit "file" "stdout" {
  description = "OpenBao API audit log"
  options {
    file_path = "stdout"
  }
}

initialize "tangow" {
  request "mount-transit" {
    operation = "update"
    path      = "sys/mounts/transit"
    data      = { type = "transit" }
  }

  request "create-vault-key" {
    operation = "update"
    path      = "transit/keys/vault"
    data      = { type = "aes256-gcm96", exportable = false }
  }

  request "write-vault-policy" {
    operation = "update"
    path      = "sys/policies/acl/tangow-vault"
    data = {
      policy = <<-POLICY
        path "transit/encrypt/vault" {
          capabilities = ["update"]
        }
        path "transit/decrypt/vault" {
          capabilities = ["update"]
        }
      POLICY
    }
  }

  request "enable-approle" {
    operation = "update"
    path      = "sys/auth/approle"
    data      = { type = "approle" }
  }

  request "create-approle" {
    operation = "update"
    path      = "auth/approle/role/tangow"
    data = {
      token_policies          = ["tangow-vault"]
      token_no_default_policy = true
      token_type              = "batch"
      token_ttl               = "5m"
    }
  }

  request "set-role-id" {
    operation = "update"
    path      = "auth/approle/role/tangow/role-id"
    data = {
      role_id = {
        eval_type   = "string"
        eval_source = "file"
        path        = "/run/secrets/role-id"
      }
    }
  }

  request "set-secret-id" {
    operation = "update"
    path      = "auth/approle/role/tangow/custom-secret-id"
    data = {
      secret_id = {
        eval_type   = "string"
        eval_source = "file"
        path        = "/run/secrets/secret-id"
      }
    }
  }
}
